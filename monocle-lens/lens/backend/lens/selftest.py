"""
make check-model — prove the configured models work before you rely on them.

Model families differ in what they accept: reasoning models (gpt-5*, gpt-6*, o*) take
max_completion_tokens and reasoning_effort and reject temperature, while older models take
max_tokens and temperature. This runs the three calls Lens actually depends on — a
structured-output chat call, an embedding, and the judge model — and prints exactly what
was sent and what came back, so a model swap fails here in seconds rather than halfway
through an ingest or a demo.

Nothing is written to the database and no spans are created.
"""
import json
import sys
import time

from lens.config import get_settings, is_reasoning_model
from lens.llm import LLMError, sampling_parameters
from openai import OpenAI

SCHEMA = {
    'type': 'object',
    'properties': {'answer': {'type': 'string'}, 'confidence': {'type': 'number'}},
    'required': ['answer', 'confidence'],
    'additionalProperties': False,
}


def _client(settings):
    return OpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url,
                  timeout=settings.llm_timeout_seconds, max_retries=0)


def check_chat(settings, model, label):
    params = sampling_parameters(model, settings.max_tokens, settings.temperature, settings.reasoning_effort)
    print(f'\n{label}: {model}')
    print(f'  family      : {"reasoning" if is_reasoning_model(model) else "standard"}')
    print(f'  parameters  : {json.dumps(params)}')
    started = time.perf_counter()
    response = _client(settings).chat.completions.create(
        model=model,
        messages=[{'role': 'system', 'content': 'Reply with a one-sentence answer and a confidence between 0 and 1.'},
                  {'role': 'user', 'content': 'Does this API call support structured outputs?'}],
        response_format={'type': 'json_schema',
                         'json_schema': {'name': 'selftest', 'strict': True, 'schema': SCHEMA}},
        **params,
    )
    elapsed = int((time.perf_counter() - started) * 1000)
    choice = response.choices[0]
    usage = response.usage
    details = getattr(usage, 'completion_tokens_details', None)
    parsed = json.loads(choice.message.content)
    print(f'  responded   : {elapsed} ms, finish_reason={choice.finish_reason}, model={response.model}')
    print(f'  tokens      : {usage.prompt_tokens} in / {usage.completion_tokens} out'
          + (f' (reasoning {details.reasoning_tokens})' if getattr(details, 'reasoning_tokens', None) else ''))
    print(f'  structured  : {json.dumps(parsed)[:120]}')
    cost = usage.prompt_tokens / 1000 * settings.cost_per_1k_input \
        + usage.completion_tokens / 1000 * settings.cost_per_1k_output
    print(f'  cost        : ${cost:.6f} at the configured rates')
    return True


def check_embedding(settings):
    print(f'\nembeddings: {settings.embedding_model}')
    started = time.perf_counter()
    response = _client(settings).embeddings.create(
        model=settings.embedding_model, input=['model risk management'],
        dimensions=settings.embedding_dimensions)
    elapsed = int((time.perf_counter() - started) * 1000)
    dimensions = len(response.data[0].embedding)
    print(f'  responded   : {elapsed} ms, {dimensions} dimensions')
    if dimensions != settings.embedding_dimensions:
        raise LLMError(f'returned {dimensions} dimensions; the schema column is '
                       f'vector({settings.embedding_dimensions})')
    print('  matches the vector(%d) column in the schema' % settings.embedding_dimensions)
    return True


def main():
    settings = get_settings()
    print('Lens model check')
    print(f'  base URL    : {settings.openai_base_url}')
    print(f'  key         : {"set" if settings.openai_api_key else "MISSING"}')
    if not settings.openai_api_key:
        sys.exit('No API key. Put LENS-OPENAI-API-KEY in the vault and restart the stack.')

    failures = []
    for label, model in (('chat', settings.chat_model), ('judge', settings.judge_model)):
        try:
            check_chat(settings, model, label)
        except Exception as e:
            failures.append(f'{label} ({model}): {e.__class__.__name__}: {e}')
            print(f'  FAILED      : {e.__class__.__name__}: {e}')
    try:
        check_embedding(settings)
    except Exception as e:
        failures.append(f'embeddings ({settings.embedding_model}): {e.__class__.__name__}: {e}')
        print(f'  FAILED      : {e.__class__.__name__}: {e}')

    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  - {f}')
        print('\nIf a model name is wrong, set LENS_CHAT_MODEL / LENS_JUDGE_MODEL / '
              'LENS_EMBEDDING_MODEL in .env and re-run. If a parameter was rejected, the error '
              'above names it.')
        raise SystemExit(1)
    print('\nAll model calls succeeded — the stack is ready for `make ingest`.')


if __name__ == '__main__':
    main()
