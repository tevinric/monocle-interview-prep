"""
Evaluation harness — make eval

Runs the question set through the real agent, scores each answer, and writes every metric
to `evals` with the threshold it was judged against, so the output is pass/fail rather
than a number that needs interpreting. Each row links to the run it came from, so a
failure can be opened in the audit view.

The LLM judge runs on a separate, cheaper deployment, and its own calls are traced in
their own run — the cost of evaluating never contaminates the runs being evaluated.
"""
import argparse
import os
import re
import statistics
import uuid

import yaml

from app import _ensure_schema
from lens.agent import runs as run_store
from lens.agent.guardrails import MARKER
from lens.agent.loop import run_agent
from lens.agent.prompts import load_prompt, sha8
from lens.config import get_settings
from lens.db import db_cursor
from lens.llm import LLMClient, LLMError, Recorder
from lens.tracing.tracer import RunTracer

QUESTIONS_FILE = os.getenv('LENS_EVAL_QUESTIONS', '/app/evals/questions.yaml')

JUDGE_SCHEMA = {
    'type': 'object',
    'properties': {
        'citations': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['marker', 'supports', 'reason'],
            'properties': {'marker': {'type': 'string'}, 'supports': {'type': 'boolean'},
                           'reason': {'type': 'string'}}}},
        'sentences': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['index', 'supported'],
            'properties': {'index': {'type': 'integer'}, 'supported': {'type': 'boolean'}}}},
    },
    'required': ['citations', 'sentences'],
    'additionalProperties': False,
}


def load_spec():
    with open(QUESTIONS_FILE, encoding='utf-8') as f:
        return yaml.safe_load(f)


def _run_facts(run_id):
    with db_cursor() as cur:
        cur.execute("""SELECT ci.marker, ci.quote, ci.section_path, d.key AS doc_key, c.text
                         FROM citations ci JOIN documents d ON d.id = ci.doc_id
                         JOIN chunks c ON c.id = ci.chunk_id
                        WHERE ci.run_id = %s ORDER BY ci.id""", (run_id,))
        citations = cur.fetchall()
        cur.execute("""SELECT DISTINCT d.key FROM retrieved_chunks rc
                         JOIN spans s ON s.id = rc.span_id JOIN documents d ON d.id = rc.doc_id
                        WHERE s.run_id = %s AND rc.retriever IN ('fused', 'lookup', 'section') AND rc.rank <= 8""",
                    (run_id,))
        retrieved_docs = {r['key'] for r in cur.fetchall()}
    return citations, retrieved_docs


def _sentences(answer):
    out = []
    for line in (answer or '').split('\n'):
        for sentence in re.split(r'(?<=[.!?])\s+(?=[A-Z("“\'])', line.strip()):
            plain = MARKER.sub('', sentence).strip()
            if plain and MARKER.search(sentence):
                out.append(sentence.strip())
    return out


def judge(llm, tracer, prompt, question, answer, citations, parent=None):
    sentences = _sentences(answer)
    if not sentences or not citations:
        return None
    rendered_sentences = '\n'.join(f'{i}. {s}' for i, s in enumerate(sentences))
    rendered_evidence = '\n\n'.join(
        f"[{c['marker']}] {c['doc_key']} — {c['section_path']}\nQUOTED: {c['quote']}\nPASSAGE: {c['text'][:1500]}"
        for c in citations)
    result = llm.chat(
        tracer, name='llm.judge', prompt=prompt, parent=parent,
        messages=[{'role': 'system', 'content': prompt.render(question=question, sentences=rendered_sentences,
                                                              evidence=rendered_evidence)},
                  {'role': 'user', 'content': 'Judge the citations and the sentences.'}],
        response_schema=JUDGE_SCHEMA, schema_name='judgement', model=llm.s.judge_model).parsed
    supported_citations = [c for c in result['citations'] if c['supports']]
    supported_sentences = [s for s in result['sentences'] if s['supported']]
    return {
        'citation_precision': round(len(supported_citations) / max(len(result['citations']), 1), 3),
        'groundedness': round(len(supported_sentences) / max(len(sentences), 1), 3),
        'detail': result,
    }


def _record(cur, batch_id, run_id, question_key, metric, value, threshold=None, passed=None, notes=None):
    cur.execute(
        """INSERT INTO evals (batch_id, run_id, question_key, metric, value, threshold, passed, notes)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
        (batch_id, run_id, question_key, metric, value, threshold, passed, notes))


def _noop(event, data):
    pass


def run_batch(only=None, emit=_noop):
    """
    Score the question set and write every metric to `evals`.

    Shared by `make eval` and the Run evaluation button, so the two cannot drift apart.
    `emit(event, data)` reports progress as it happens — 'batch', 'question', 'metric'
    and 'done' — and defaults to doing nothing for the CLI path, which prints instead.
    Returns the batch summary; raising is left to the caller.
    """
    settings = get_settings()
    _ensure_schema()
    spec = load_spec()
    thresholds = spec['thresholds']
    questions = [q for q in spec['questions'] if not only or q['key'] in only]
    batch_id = str(uuid.uuid4())
    emit('batch', {'batch_id': batch_id, 'total': len(questions),
                   'demo_mode': settings.demo_mode})

    judge_prompt = load_prompt('judge')
    judge_bundle = sha8(judge_prompt.template)
    judge_run = run_store.start(f'LLM judge for eval batch {batch_id}', settings, {'judge': judge_prompt},
                                judge_bundle)
    judge_tracer = RunTracer(judge_run['id'], judge_run['trace_id'])

    per_question, latencies, costs = [], [], []

    for index, entry in enumerate(questions, start=1):
        expect_abstain = entry.get('answerable') is False
        summary = run_agent(entry['question'], settings)
        citations, retrieved_docs = _run_facts(summary['run_id'])
        expected_docs = set(entry.get('expected_documents') or [])
        hit = bool(expected_docs & retrieved_docs) if expected_docs else None
        abstained = summary['status'] == 'abstained'
        scores = None
        if not expect_abstain and summary['status'] == 'ok':
            judge_llm = LLMClient(settings, Recorder('replay' if settings.demo_mode else 'live',
                                                     f"eval-judge {entry['key']}"))
            try:
                with judge_tracer.span(f"eval.{entry['key']}", type='agent') as span:
                    scores = judge(judge_llm, judge_tracer, judge_prompt, entry['question'],
                                   summary['answer'], citations, parent=span)
            except LLMError as e:
                print(f"    judge unavailable: {e}")

        must_cite = entry.get('must_cite_contains') or []
        must_cite_hit = (any(any(needle.lower() in (c['section_path'] or '').lower() for c in citations)
                             for needle in must_cite) if must_cite else None)

        latencies.append(summary['latency_ms'])
        costs.append(summary['cost_usd'])
        per_question.append({'key': entry['key'], 'run_id': summary['run_id'], 'status': summary['status'],
                             'expect_abstain': expect_abstain, 'abstained': abstained, 'hit': hit,
                             'scores': scores, 'must_cite_hit': must_cite_hit,
                             'latency_ms': summary['latency_ms'], 'cost_usd': summary['cost_usd']})
        emit('question', {
            'index': index, 'total': len(questions), 'key': entry['key'],
            'question': entry['question'], 'run_id': summary['run_id'], 'status': summary['status'],
            'expected_abstain': expect_abstain, 'abstained': abstained, 'retrieval_hit': hit,
            'latency_ms': summary['latency_ms'], 'cost_usd': summary['cost_usd'],
            'citation_precision': scores['citation_precision'] if scores else None,
            'groundedness': scores['groundedness'] if scores else None,
            'ok': abstained == expect_abstain and summary['status'] != 'error',
        })

    with db_cursor(commit=True) as cur:
        for q in per_question:
            _record(cur, batch_id, q['run_id'], q['key'], 'status', 1 if q['status'] != 'error' else 0,
                    notes=q['status'])
            if q['hit'] is not None:
                _record(cur, batch_id, q['run_id'], q['key'], 'retrieval_hit_at_8', 1 if q['hit'] else 0)
            if q['must_cite_hit'] is not None:
                _record(cur, batch_id, q['run_id'], q['key'], 'must_cite', 1 if q['must_cite_hit'] else 0)
            _record(cur, batch_id, q['run_id'], q['key'], 'abstention_correct',
                    1 if q['abstained'] == q['expect_abstain'] else 0)
            _record(cur, batch_id, q['run_id'], q['key'], 'latency_ms', q['latency_ms'])
            _record(cur, batch_id, q['run_id'], q['key'], 'cost_usd', q['cost_usd'])
            if q['scores']:
                _record(cur, batch_id, q['run_id'], q['key'], 'citation_precision', q['scores']['citation_precision'])
                _record(cur, batch_id, q['run_id'], q['key'], 'groundedness', q['scores']['groundedness'])

        judged = [q['scores'] for q in per_question if q['scores']]
        answerable = [q for q in per_question if not q['expect_abstain']]
        unanswerable = [q for q in per_question if q['expect_abstain']]
        summary_metrics = {
            'citation_precision': statistics.fmean([s['citation_precision'] for s in judged]) if judged else None,
            'groundedness': statistics.fmean([s['groundedness'] for s in judged]) if judged else None,
            'retrieval_hit_rate_at_8': (statistics.fmean([1 if q['hit'] else 0 for q in answerable if q['hit'] is not None])
                                        if any(q['hit'] is not None for q in answerable) else None),
            'abstention_correctness': (statistics.fmean([1 if q['abstained'] else 0 for q in unanswerable])
                                       if unanswerable else None),
            'latency_p50_ms': statistics.median(latencies) if latencies else None,
            'latency_p95_ms': (sorted(latencies)[max(int(len(latencies) * 0.95) - 1, 0)] if latencies else None),
            'cost_per_question_usd': statistics.fmean(costs) if costs else None,
        }
        maxima = {'latency_p95_ms', 'cost_per_question_usd'}
        failures = []
        for metric, value in summary_metrics.items():
            threshold = thresholds.get(metric)
            passed = None
            if value is not None and threshold is not None:
                passed = value <= threshold if metric in maxima else value >= threshold
                if not passed:
                    failures.append(metric)
            _record(cur, batch_id, None, None, metric, value, threshold, passed,
                    'no judged runs' if value is None else None)
            emit('metric', {'metric': metric, 'value': value, 'threshold': threshold, 'passed': passed})

    run_store.finish(judge_tracer, judge_run, {'status': 'ok', 'answer': f'Judged eval batch {batch_id}',
                                               'citations': [], 'confidence': None})
    judge_tracer.close()    # after finish(): it reads the judge run's own totals
    result = {'batch_id': batch_id, 'failures': failures, 'passed': not failures,
              'questions': len(per_question), 'metrics': summary_metrics}
    emit('done', result)
    return result


def main():
    """The CLI face of run_batch: same work, printed as it goes."""
    parser = argparse.ArgumentParser(description='Run the Lens evaluation set')
    parser.add_argument('--only', action='append', default=[], help='run only these question keys')
    args = parser.parse_args()

    seen_metric = []

    def report(event, data):
        if event == 'batch':
            print(f"\nEval batch {data['batch_id']}  ({data['total']} questions, "
                  f"{'demo mode' if data['demo_mode'] else 'live'})\n")
        elif event == 'question':
            retrieval = 'hit' if data['retrieval_hit'] else ('miss' if data['retrieval_hit'] is False else '—')
            judged = ''
            if data['citation_precision'] is not None:
                judged = (f"  precision {data['citation_precision']:.2f}"
                          f"  grounded {data['groundedness']:.2f}")
            print(f"  {'ok ' if data['ok'] else 'FAIL'} {data['key']:<26} {data['status']:<10} "
                  f"{data['latency_ms']:>6} ms  ${data['cost_usd']:.4f}  {retrieval:<5}{judged}")
        elif event == 'metric':
            if not seen_metric:
                seen_metric.append(True)
                print('\n  metric                      value      threshold   result')
            value, threshold, metric = data['value'], data['threshold'], data['metric']
            shown = '—' if value is None else (f'{value:,.0f}' if 'ms' in metric else f'{value:.3f}')
            limit = '—' if threshold is None else (f'{threshold:,.0f}' if 'ms' in metric else f'{threshold:.3f}')
            print(f"  {metric:<26} {shown:>9}  {limit:>10}   "
                  f"{'—' if data['passed'] is None else ('PASS' if data['passed'] else 'FAIL')}")

    result = run_batch(only=args.only, emit=report)
    print(f"\nbatch {result['batch_id']} — "
          f"{'FAILED: ' + ', '.join(result['failures']) if result['failures'] else 'all thresholds met'}")
    raise SystemExit(1 if result['failures'] else 0)


if __name__ == '__main__':
    main()
