"""
make record — capture live model responses so demo mode can run with no Azure connection.

Each question is run for real against Azure OpenAI; every model response (plans, answers
and query embeddings) is written to lens/demo/recordings/<question hash>.json. Demo mode
then replays those responses while retrieval, tools, guardrails and tracing still run for
real against the database.

Recordings are captured from a real deployment — they are not synthetic.
"""
import argparse
import os

import yaml

from app import _ensure_schema
from lens.agent.loop import run_agent
from lens.config import get_settings
from lens.demo.seed import load_questions

EVAL_QUESTIONS = '/app/evals/questions.yaml'


def main():
    parser = argparse.ArgumentParser(description='Record live model responses for demo mode')
    parser.add_argument('--evals', action='store_true', help='also record the evaluation question set')
    args = parser.parse_args()

    settings = get_settings()
    if settings.demo_mode:
        raise SystemExit('LENS_DEMO_MODE is true — recording needs a live Azure OpenAI deployment.')
    _ensure_schema()

    entries = [(q['key'], q['question'], q.get('fault_injection')) for q in load_questions()]
    if args.evals and os.path.exists(EVAL_QUESTIONS):
        with open(EVAL_QUESTIONS, encoding='utf-8') as f:
            entries += [(q['key'], q['question'], None) for q in yaml.safe_load(f)['questions']]

    for key, question, fault in entries:
        summary = run_agent(question, settings, record=True, fault_injection=fault)
        where = os.path.basename(summary.get('recording') or '—')
        print(f"  {key:<24} {summary['status']:<10} {summary['latency_ms']:>6} ms  → {where}")


if __name__ == '__main__':
    main()
