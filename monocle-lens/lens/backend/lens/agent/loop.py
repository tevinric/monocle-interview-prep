"""
The agent loop — hand-written and short, so that every step is visible.

  guardrail (input PII)
    → plan (structured output)
    → tools, in parallel
    → repeat while the planner says the evidence is insufficient (max iterations)
    → synthesise (structured output: answer, citations, confidence, unsupported claims)
    → guardrail (groundedness: citations must resolve and quotes must be verbatim)
    → answer, or abstain and say what was searched

No orchestration framework on purpose: the thing being demonstrated is that each step is
inspectable afterwards, and a framework would hide exactly that. Every stage is a span.
"""
import time

from concurrent.futures import ThreadPoolExecutor

from lens.agent import guardrails, runs as run_store, tools
from lens.agent.evidence import EvidenceBook
from lens.agent.prompts import load_bundle
from lens.corpus import load_manifest
from lens.llm import LLMClient, Recorder
from lens.tracing.otlp import export_run_async
from lens.tracing.tracer import RunTracer

SYNTHESIS_SCHEMA = {
    'type': 'object',
    'properties': {
        'answer': {'type': 'string', 'description': 'The answer, every factual sentence ending with its [E#] markers.'},
        'citations': {
            'type': 'array',
            'items': {'type': 'object', 'additionalProperties': False,
                      'required': ['evidence_id', 'quote'],
                      'properties': {'evidence_id': {'type': 'string', 'description': 'An evidence id such as E3.'},
                                     'quote': {'type': 'string', 'description': 'Verbatim quote from that evidence, at most 30 words.'}}},
        },
        'confidence': {'type': 'number', 'description': '0 to 1: how completely the cited evidence answers the question.'},
        'unsupported_claims': {'type': 'array', 'items': {'type': 'string'},
                               'description': 'Sentences in your answer you could not support; they will be stripped.'},
    },
    'required': ['answer', 'citations', 'confidence', 'unsupported_claims'],
    'additionalProperties': False,
}


def _noop(event, data):
    pass


MEMORY_TURNS = 5


def format_history(history):
    """
    The last few messages, as plain text for a prompt.

    Capped at MEMORY_TURNS messages — the most recent ones — so a long session cannot
    quietly grow the prompt, the cost, or the number of places an earlier answer could
    leak into a later one. Truncated per message for the same reason.
    """
    rows = []
    for m in (history or [])[-MEMORY_TURNS:]:
        role = 'User' if str(m.get('role')) == 'user' else 'Lens'
        text = ' '.join(str(m.get('content') or '').split())[:600]
        if text:
            rows.append(f'{role}: {text}')
    return '\n'.join(rows) if rows else '(no earlier messages — this is the first turn)'


def run_agent(question, settings, conversation_id=None, replay_of=None, record=False,
              fault_injection=None, emit=_noop, replay_calls=None, expect=None, history=None):
    """
    Execute one turn.

    `history` is the last few messages of the thread, so a follow-up ("and under POPIA?")
    can be resolved into a full question. It informs what to search for and how to word the
    reply — never what is true. Every fact still comes from evidence retrieved in this turn
    and still passes the groundedness check, so an answer stays auditable on its own. The
    exact context used is recorded on the root span.

    `replay_calls` serves the model responses from a past run's trace instead of the API.
    Everything else — retrieval, tools, guardrails, citation verification — still runs for
    real, so the answer is reproduced rather than copied. `expect` is that run's recorded
    outcome; the summary then reports whether the reproduction matched it exactly.
    """
    prompts, bundle_hash = load_bundle()
    screening = guardrails.scan_pii(question)
    run = run_store.start(screening.text, settings, prompts, bundle_hash, conversation_id, replay_of, fault_injection)
    tracer = RunTracer(run['id'], run['trace_id'])
    emit('run', run)
    outcome = {'status': 'error', 'answer': None, 'citations': [], 'confidence': None}
    recorder = None
    book = EvidenceBook()

    try:
        conversation = format_history(history)
        with tracer.span('agent.run', type='agent',
                         input={'question': screening.text, 'conversation': conversation},
                         attributes={'prompt_bundle': bundle_hash, 'config_hash': run['config_hash'],
                                     'memory_messages': len((history or [])[-MEMORY_TURNS:]),
                                     'memory_limit': MEMORY_TURNS}) as root:
            with tracer.span('guardrail.input_pii', type='guardrail',
                             input={'characters': len(question)}) as span:
                span.set_output(screening.detail)
                tracer.record_guardrail(span, 'input_pii', screening.verdict, screening.detail)
            emit('step', {'name': 'guardrail.input_pii', 'verdict': screening.verdict})

            if replay_calls is not None:
                recorder = Recorder('replay', screening.text, calls=replay_calls, source_label='trace')
            else:
                mode = 'record' if record else ('replay' if settings.demo_mode else 'live')
                recorder = Recorder(mode, screening.text)
            llm = LLMClient(settings, recorder)
            ctx = tools.ToolContext(tracer, llm, fault_injection)
            corpus = tools.corpus_listing()

            for iteration in range(1, settings.max_tool_iterations + 1):
                with tracer.span(f'agent.iteration.{iteration}', type='agent') as step:
                    plan = llm.chat(
                        tracer, name='llm.plan', prompt=prompts['planner'], parent=step,
                        messages=[
                            {'role': 'system', 'content': prompts['planner'].render(
                                corpus=corpus, iteration=iteration, max_iterations=settings.max_tool_iterations,
                                conversation=conversation)},
                            {'role': 'user', 'content': f'Question: {screening.text}\n\n{book.planner_view()}'},
                        ],
                        response_schema=tools.plan_schema(), schema_name='plan').parsed
                    step.set_output({'intent': plan['intent'], 'frameworks': plan['frameworks'],
                                     'evidence_sufficient': plan['evidence_sufficient'],
                                     'tool_calls': plan['tool_calls']})
                    emit('plan', {'iteration': iteration, **plan})
                    if not plan['tool_calls'] or (iteration > 1 and plan['evidence_sufficient']):
                        break
                    calls = plan['tool_calls']
                    with ThreadPoolExecutor(max_workers=min(4, len(calls))) as pool:
                        results = list(pool.map(
                            lambda c: tools.run_tool(ctx, c['tool'], c['arguments'], step), calls))
                    for result in results:
                        book.add(result)
                        emit('tool', tools.summarise_result(result))

            grounded, model_confidence = None, 0.0
            if book.items:
                answer = llm.chat(
                    tracer, name='llm.synthesise', prompt=prompts['synthesiser'], parent=root,
                    messages=[
                        {'role': 'system', 'content': prompts['synthesiser'].render(
                            question=screening.text, evidence=book.synthesiser_view(),
                            conversation=conversation)},
                        {'role': 'user', 'content': 'Answer the question using only that evidence.'},
                    ],
                    response_schema=SYNTHESIS_SCHEMA, schema_name='answer').parsed
                model_confidence = float(answer['confidence'])
                with tracer.span('guardrail.groundedness', type='guardrail',
                                 input={'citations': answer['citations'],
                                        'unsupported_claims': answer['unsupported_claims']}) as span:
                    grounded = guardrails.check_groundedness(
                        answer['answer'], answer['citations'], answer['unsupported_claims'], book.items)
                    span.set_output(grounded.detail())
                    tracer.record_guardrail(span, 'groundedness', grounded.verdict, grounded.detail())
                emit('step', {'name': 'guardrail.groundedness', 'verdict': grounded.verdict})

            confidence = round(model_confidence * grounded.verified_ratio, 3) if grounded else 0.0
            reasons = []
            if not book.items:
                reasons.append('nothing in the corpus matched the question')
            elif not grounded.citations:
                reasons.append('no claim could be tied to a verified quotation')
            if confidence < settings.confidence_threshold:
                reasons.append(f'confidence {confidence:.2f} is below the threshold '
                               f'{settings.confidence_threshold:.2f}')

            with tracer.span('guardrail.abstention', type='guardrail',
                             input={'model_confidence': model_confidence,
                                    'verified_ratio': grounded.verified_ratio if grounded else 0.0,
                                    'threshold': settings.confidence_threshold}) as span:
                detail = {'confidence': confidence, 'threshold': settings.confidence_threshold,
                          'reasons': reasons, 'searched': book.searched}
                span.set_output(detail)
                tracer.record_guardrail(span, 'abstention', 'abstain' if reasons else 'answer', detail)

            if reasons:
                names = [d['short_name'] for d in load_manifest()]
                outcome = {'status': 'abstained',
                           'answer': guardrails.abstention_message(reasons, book.searched, names),
                           'citations': [], 'confidence': confidence, 'abstain_reason': '; '.join(reasons)}
            else:
                tracer.record_citations(grounded.citations)
                tracer.mark_used({c['chunk_id'] for c in grounded.citations})
                outcome = {'status': 'ok', 'answer': grounded.answer, 'citations': grounded.citations,
                           'confidence': confidence}
            root.set_output({'status': outcome['status'], 'confidence': confidence,
                             'citations': len(outcome['citations']), 'evidence': len(book.items)})
    except Exception as e:
        outcome = {'status': 'error', 'answer': None, 'citations': [], 'confidence': None,
                   'error': f'{e.__class__.__name__}: {e}'}
    finally:
        summary = run_store.finish(tracer, run, outcome)
        tracer.close()

    if record and recorder and outcome['status'] != 'error':
        summary['recording'] = recorder.save({'chat_model': settings.chat_model,
                                              'embedding_model': settings.embedding_model,
                                              'prompt_bundle': bundle_hash, 'status': outcome['status']})
    if expect is not None:
        summary['reproduction'] = _reproduction_verdict(expect, outcome, recorder)
    _stream_answer(emit, outcome, settings)
    emit('done', summary)
    if settings.otlp_endpoint:
        export_run_async(run['id'], settings.otlp_endpoint)
    return summary


def _citation_fingerprint(citations):
    """Marker, chunk and character range — what a citation actually asserts."""
    return [[c.get('marker'), str(c.get('chunk_id')), c.get('char_start'), c.get('char_end')]
            for c in (citations or [])]


def _reproduction_verdict(expect, outcome, recorder):
    """
    Did re-executing the pipeline against the recorded model responses land on the same
    answer? Anything other than `identical` is a finding, and says what moved.
    """
    differences = []
    if (expect.get('answer') or '') != (outcome.get('answer') or ''):
        differences.append('the answer text differs')
    if _citation_fingerprint(expect.get('citations')) != _citation_fingerprint(outcome.get('citations')):
        differences.append('the citations differ')
    if expect.get('status') != outcome.get('status'):
        differences.append(f"the status changed from {expect.get('status')} to {outcome.get('status')}")
    if recorder is not None and recorder.divergences:
        differences.extend(f"{d['call']}: {d['reason']}" for d in recorder.divergences)
    return {
        'identical': not differences,
        'differences': differences,
        'replayed_calls': len(getattr(recorder, '_recorded', []) or []),
        'source_run_id': expect.get('run_id'),
    }


def _stream_answer(emit, outcome, settings):
    """The answer is released only after the groundedness check, then streamed."""
    text = outcome.get('answer') or ''
    words = text.split(' ')
    for i in range(0, len(words), 4):
        emit('token', {'text': ' '.join(words[i:i + 4]) + (' ' if i + 4 < len(words) else '')})
        if settings.demo_mode:
            time.sleep(0.03)
    emit('answer', {'status': outcome['status'], 'citations': outcome.get('citations', []),
                    'confidence': outcome.get('confidence'), 'error': outcome.get('error')})
