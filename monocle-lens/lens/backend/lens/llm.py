"""
OpenAI — the only module that talks to a model.

Every call:
  * runs inside an `llm` span recording the model, prompt name and version hash, the
    sampling parameters actually sent, the exact request (messages, response schema), the
    raw response, finish reason, token split and cost;
  * has a timeout and exactly one retry with backoff on transient failures;
  * in demo mode is answered from a recording instead of the network — and the span says
    so (attributes.llm_source = "recording").

Parameter shape depends on the model family, which the API enforces:
  reasoning models (gpt-5*, gpt-6*, o*)  max_completion_tokens + reasoning_effort, no temperature
  everything else (gpt-4o, gpt-4.1, …)   max_tokens + temperature

Recordings: one JSON file per normalised question in lens/demo/recordings/, holding every
model response the agent received for it. Calls are matched by a digest of the request, so
a replay that diverges from the recording (e.g. an edited prompt) is visible in the trace
rather than silently papered over.
"""
import hashlib
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone

from openai import APIConnectionError, BadRequestError, InternalServerError, OpenAI, RateLimitError

from lens.config import REASONING_EFFORTS, is_reasoning_model

logger = logging.getLogger(__name__)

RETRYABLE = (APIConnectionError, RateLimitError, InternalServerError)   # APITimeoutError is an APIConnectionError
RETRY_DELAY_SECONDS = 2.0
# Replays keep the shape of the original latency so a demo feels like the real thing.
REPLAY_SPEED = 0.5
MAX_REPLAY_DELAY_SECONDS = 2.5
RECORDINGS_DIR = os.path.join(os.path.dirname(__file__), 'demo', 'recordings')


class LLMError(RuntimeError):
    pass


# Which Lens variable a rejected request parameter comes from. The API is the authority
# on what a model accepts; this only turns its answer into an instruction.
PARAM_TO_SETTING = {
    'reasoning_effort': 'LENS_REASONING_EFFORT',
    'temperature': 'LENS_LLM_TEMPERATURE',
    'max_tokens': 'LENS_LLM_MAX_TOKENS',
    'max_completion_tokens': 'LENS_LLM_MAX_TOKENS',
    'model': 'LENS_CHAT_MODEL',
}


def _config_error_from(exc, model=None):
    """Turn a 400 into a message naming the variable to change and what it may hold."""
    body = getattr(exc, 'body', None) or {}
    error = body.get('error') if isinstance(body, dict) else {}
    error = error if isinstance(error, dict) else {}
    param = error.get('param')
    detail = error.get('message') or str(exc)
    setting = PARAM_TO_SETTING.get(param)
    model = model or 'The model'

    if param == 'reasoning_effort':
        return LLMError(
            f'{model} rejected the reasoning_effort that LENS_REASONING_EFFORT is set to. '
            f'The API says: {detail} Lens accepts {", ".join(REASONING_EFFORTS)} — set '
            'LENS_REASONING_EFFORT in docker-compose.yml or the root .env and restart the backend.')
    if param in ('temperature', 'max_tokens', 'max_completion_tokens'):
        family = 'reasoning' if is_reasoning_model(model) else 'standard'
        return LLMError(
            f'{model} rejected {param}, which Lens sends because it treats the model as the '
            f'{family} family. The API says: {detail} If that is wrong, adjust '
            'REASONING_MODEL_PREFIXES in lens/config.py so the model is detected correctly.')
    if setting:
        return LLMError(f'{model} rejected {param} (from {setting}). The API says: {detail}')
    return LLMError(f'{model} rejected the request. The API says: {detail}')


def normalise_question(question):
    text = re.sub(r'\s+', ' ', question or '').strip().lower()
    return text.rstrip(' ?.!')


def question_hash(question):
    return hashlib.sha256(normalise_question(question).encode('utf-8')).hexdigest()[:16]


def _digest(kind, payload):
    canonical = json.dumps({'kind': kind, 'payload': payload}, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def calls_from_spans(spans):
    """
    Rebuild replayable chat calls from a past run's `llm` spans.

    A chat span stores the exact request it sent and the exact response it received, so
    the digest computed here is the same one `chat()` computes at call time — an
    unchanged pipeline matches every call exactly, and a changed one falls through to
    the sequence fallback and is reported as a divergence.

    Embedding spans are skipped: they do not store their vectors, and embeddings are
    deterministic for identical input, so they are simply recomputed.
    """
    calls = []
    for span in spans:
        if span.get('type') != 'llm':
            continue
        request = span.get('input_json') or {}
        response = span.get('output_json') or {}
        if 'messages' not in request or not response:
            continue
        calls.append({
            'kind': 'chat',
            'name': span.get('name'),
            'digest': _digest('chat', request),
            'response': response,
            'latency_ms': span.get('duration_ms'),
        })
    return calls


def sampling_parameters(model, max_tokens, temperature, reasoning_effort):
    """What this model family actually accepts. Sent verbatim and recorded on the span."""
    if is_reasoning_model(model):
        params = {'max_completion_tokens': max_tokens}
        if reasoning_effort:
            params['reasoning_effort'] = reasoning_effort
        return params
    return {'max_tokens': max_tokens, 'temperature': temperature}


# =============================================================================
# RECORDER — live / record / replay
# =============================================================================
class Recorder:
    """
    Where model responses come from.

      live      the API
      record    the API, capturing every response to a file for demo mode
      replay    a recording — either a demo file on disk, or (with `calls`) the chat
                spans of a past run, read back out of its own audit trail

    The last of those is what makes a run reproducible: the sampled, non-deterministic
    part of the pipeline is served from what was recorded at the time, so everything
    downstream — retrieval, tools, guardrails, citations — re-executes for real and has
    to arrive at the same answer. If it does not, the trace was not a complete record.
    """

    def __init__(self, mode='live', question=None, directory=RECORDINGS_DIR,
                 calls=None, source_label=None):
        if mode not in ('live', 'record', 'replay'):
            raise ValueError(mode)
        self.mode = mode
        self.question = question
        self.qhash = question_hash(question) if question else None
        self.path = os.path.join(directory, f'{self.qhash}.json') if self.qhash else None
        self._lock = threading.Lock()
        self._captured = []
        self._recorded = []
        self._consumed = set()
        self._source_label = source_label
        self.divergences = []
        self.meta = {}
        if mode == 'replay':
            if calls is not None:
                # Replaying a specific past run rather than a demo recording.
                self._recorded = list(calls)
                self.path = None
            else:
                if not self.path or not os.path.exists(self.path):
                    raise LLMError(
                        f'Demo mode has no recording for this question (hash {self.qhash}). '
                        'Record it once with a live API key: make record.'
                    )
                with open(self.path, encoding='utf-8') as f:
                    data = json.load(f)
                self._recorded = data['calls']
                self.meta = data.get('meta', {})

    @property
    def source(self):
        if self._source_label:
            return self._source_label
        return 'recording' if self.mode == 'replay' else 'live'

    @property
    def origin(self):
        """What to name on the span as the thing being replayed from."""
        return os.path.basename(self.path) if self.path else (self._source_label or 'recording')

    @property
    def exact(self):
        """True when every replayed call matched its request byte for byte."""
        return not self.divergences

    def capture(self, kind, name, digest, response, latency_ms=None):
        if self.mode != 'record':
            return
        with self._lock:
            self._captured.append({'kind': kind, 'name': name, 'digest': digest, 'response': response,
                                   'latency_ms': latency_ms})

    def replay(self, kind, name, digest, span):
        """Exact digest match first; for chat, fall back to the next unconsumed call of the
        same name and say so on the span — divergence is shown, never hidden."""
        with self._lock:
            for i, call in enumerate(self._recorded):
                if i not in self._consumed and call['kind'] == kind and call['digest'] == digest:
                    self._consumed.add(i)
                    span.set_attributes(recording_match='exact', recording_source=self.origin)
                    return call
            if kind == 'chat':
                for i, call in enumerate(self._recorded):
                    if i not in self._consumed and call['kind'] == kind and call['name'] == name:
                        self._consumed.add(i)
                        span.set_attributes(recording_match='sequence-fallback',
                                            recording_source=self.origin,
                                            recording_note='request differs from the recording '
                                                           '(prompt, config or evidence changed)')
                        self.divergences.append(
                            {'call': name, 'reason': 'the request sent this time differs from the one recorded'})
                        return call
        raise LLMError(f'{self.origin} has no {kind} response for {name}.')

    def save(self, meta):
        if self.mode != 'record':
            return None
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        payload = {
            'meta': {**meta, 'question': self.question, 'question_hash': self.qhash,
                     'recorded_at': datetime.now(timezone.utc).isoformat()},
            'calls': self._captured,
        }
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, indent=1)
        return self.path


# =============================================================================
# CLIENT
# =============================================================================
class LLMResult:
    def __init__(self, content, parsed, usage, cost_usd, finish_reason):
        self.content = content
        self.parsed = parsed
        self.usage = usage
        self.cost_usd = cost_usd
        self.finish_reason = finish_reason


class LLMClient:
    def __init__(self, settings, recorder=None):
        self.s = settings
        self.recorder = recorder or Recorder('live')
        self._client = None

    def _openai(self):
        if self._client is None:
            if not self.s.openai_api_key:
                raise LLMError('No OpenAI API key configured (LENS-OPENAI-API-KEY in Key Vault).')
            self._client = OpenAI(
                api_key=self.s.openai_api_key,
                base_url=self.s.openai_base_url,
                timeout=self.s.llm_timeout_seconds,
                max_retries=0,          # retries are ours: exactly one, visible on the span
            )
        return self._client

    def _with_retry(self, call, span, model=None):
        attempt = 0
        while True:
            attempt += 1
            try:
                result = call()
                span.set_attributes(attempts=attempt)
                return result
            except BadRequestError as e:
                # A malformed request will be malformed on the retry too.
                span.set_attributes(attempts=attempt)
                raise _config_error_from(e, model or self.s.chat_model) from e
            except RETRYABLE as e:
                if attempt >= 2:
                    span.set_attributes(attempts=attempt)
                    raise LLMError(f'{e.__class__.__name__} after {attempt} attempts: {e}') from e
                delay = RETRY_DELAY_SECONDS * attempt
                span.set_attributes(retry_reason=e.__class__.__name__, retry_delay_seconds=delay)
                logger.warning(f'LLM call {span.name} failed ({e.__class__.__name__}); retrying in {delay}s')
                time.sleep(delay)

    def _replay_delay(self, call, span):
        delay = min((float(call.get('latency_ms') or 0) / 1000) * REPLAY_SPEED, MAX_REPLAY_DELAY_SECONDS)
        if delay > 0:
            span.set_attributes(replay_delay_ms=int(delay * 1000))
            time.sleep(delay)

    def _cost(self, input_tokens, output_tokens):
        return round(input_tokens / 1000 * self.s.cost_per_1k_input
                     + output_tokens / 1000 * self.s.cost_per_1k_output, 6)

    # ── chat ────────────────────────────────────────────────────────────────
    def chat(self, tracer, *, name, messages, prompt, response_schema=None, schema_name=None,
             model=None, temperature=None, max_tokens=None, parent=None):
        model = model or self.s.chat_model
        temperature = self.s.temperature if temperature is None else temperature
        max_tokens = max_tokens or self.s.max_tokens
        params = sampling_parameters(model, max_tokens, temperature, self.s.reasoning_effort)
        request = {'messages': messages}
        if response_schema:
            request['response_format'] = {
                'type': 'json_schema',
                'json_schema': {'name': schema_name, 'strict': True, 'schema': response_schema},
            }
        attributes = {
            'model': model,
            'prompt_name': prompt.name,
            'prompt_version': prompt.hash,
            'llm_source': self.recorder.source,
            **params,
        }
        span_input = {'model': model, **params, **request}
        with tracer.span(name, type='llm', parent=parent, input=span_input, attributes=attributes) as span:
            digest = _digest('chat', {**request, 'model': model, **params})
            if self.recorder.mode == 'replay':
                call = self.recorder.replay('chat', name, digest, span)
                result = call['response']
                self._replay_delay(call, span)
            else:
                started = time.perf_counter()
                response = self._with_retry(
                    lambda: self._openai().chat.completions.create(model=model, **params, **request),
                    span, model)
                result = _chat_payload(response)
                self.recorder.capture('chat', name, digest, result, int((time.perf_counter() - started) * 1000))

            usage = result.get('usage') or {}
            input_tokens = int(usage.get('input_tokens') or 0)
            output_tokens = int(usage.get('output_tokens') or 0)
            cost = self._cost(input_tokens, output_tokens)
            span.set_output(result)
            span.set_attributes(input_tokens=input_tokens, output_tokens=output_tokens, cost_usd=cost,
                                reasoning_tokens=usage.get('reasoning_tokens'),
                                finish_reason=result.get('finish_reason'))

            if result.get('refusal'):
                raise LLMError(f"Model refused: {result['refusal']}")
            if result.get('finish_reason') == 'length':
                budget = params.get('max_completion_tokens') or params.get('max_tokens')
                reasoning_tokens = int(usage.get('reasoning_tokens') or 0)
                spent = (f'{output_tokens} of {budget} tokens were generated'
                         + (f', {reasoning_tokens} of them on reasoning' if reasoning_tokens else '')
                         + '. ')
                raise LLMError(
                    f'{model} truncated its answer (finish_reason=length). ' + spent
                    + 'Raise LENS_LLM_MAX_TOKENS'
                    + (f' above {budget}' if budget else '')
                    + (f', or lower LENS_REASONING_EFFORT (currently {self.s.reasoning_effort}) so '
                       'less of the budget goes on reasoning.' if reasoning_tokens
                       else ' so the answer fits.'))
            if result.get('finish_reason') == 'content_filter':
                raise LLMError('The content filter blocked the response.')
            parsed = None
            if response_schema:
                try:
                    parsed = json.loads(result.get('content') or '')
                except json.JSONDecodeError as e:
                    raise LLMError(f'Structured output was not valid JSON: {e}')
            return LLMResult(result.get('content'), parsed, usage, cost, result.get('finish_reason'))

    # ── embeddings ──────────────────────────────────────────────────────────
    def embed(self, texts, tracer=None, name='llm.embed', parent=None):
        """Embed texts. With a tracer (queries at run time) the call is a span; ingest passes none."""
        model = self.s.embedding_model
        if tracer is None:
            return self._embed_raw(texts, model, span=None)[0]
        attributes = {'model': model, 'dimensions': self.s.embedding_dimensions,
                      'llm_source': self.recorder.source}
        with tracer.span(name, type='llm', parent=parent,
                         input={'model': model, 'input': texts, 'dimensions': self.s.embedding_dimensions},
                         attributes=attributes) as span:
            if self.recorder.mode == 'replay':
                vectors, tokens, call = [], 0, None
                for text in texts:
                    call = self.recorder.replay('embedding', name, _digest('embedding', text), span)
                    vectors.append(call['response']['vector'])
                    tokens += int(call['response'].get('tokens') or 0)
                if call:
                    self._replay_delay(call, span)
            else:
                started = time.perf_counter()
                vectors, tokens = self._embed_raw(texts, model, span)
                latency_ms = int((time.perf_counter() - started) * 1000)
                for text, vector in zip(texts, vectors):
                    self.recorder.capture('embedding', name, _digest('embedding', text),
                                          {'vector': vector, 'tokens': tokens // max(len(texts), 1)},
                                          latency_ms // max(len(texts), 1))
            cost = round(tokens / 1000 * self.s.cost_per_1k_embedding, 6)
            span.set_output({'n': len(vectors), 'dimensions': len(vectors[0]) if vectors else 0,
                             'usage': {'input_tokens': tokens}})
            span.set_attributes(input_tokens=tokens, output_tokens=0, cost_usd=cost)
            return vectors

    def _embed_raw(self, texts, model, span):
        def call():
            return self._openai().embeddings.create(model=model, input=texts,
                                                    dimensions=self.s.embedding_dimensions)
        response = (_retry_without_span(call, model) if span is None
                    else self._with_retry(call, span, model))
        vectors = [item.embedding for item in sorted(response.data, key=lambda d: d.index)]
        for v in vectors:
            if len(v) != self.s.embedding_dimensions:
                raise LLMError(f'Embedding has {len(v)} dimensions; the schema expects '
                               f'{self.s.embedding_dimensions}.')
        tokens = getattr(response.usage, 'prompt_tokens', 0) if response.usage else 0
        return vectors, tokens


def _retry_without_span(call, model=None):
    """The ingest path, which has no tracer. Same rules as _with_retry."""
    for attempt in (1, 2):
        try:
            return call()
        except BadRequestError as e:
            raise _config_error_from(e, model) from e
        except RETRYABLE as e:
            if attempt == 2:
                raise LLMError(f'{e.__class__.__name__} after 2 attempts: {e}') from e
            time.sleep(RETRY_DELAY_SECONDS)


def _chat_payload(response):
    choice = response.choices[0]
    message = choice.message
    usage = response.usage
    details = getattr(usage, 'completion_tokens_details', None) if usage else None
    return {
        'id': response.id,
        'model': response.model,
        'system_fingerprint': getattr(response, 'system_fingerprint', None),
        'finish_reason': choice.finish_reason,
        'content': message.content,
        'refusal': getattr(message, 'refusal', None),
        'usage': {
            'input_tokens': usage.prompt_tokens if usage else 0,
            'output_tokens': usage.completion_tokens if usage else 0,
            'total_tokens': usage.total_tokens if usage else 0,
            # Reasoning models bill thinking tokens as output; keep them visible in the trace.
            'reasoning_tokens': getattr(details, 'reasoning_tokens', None) if details else None,
        },
    }
