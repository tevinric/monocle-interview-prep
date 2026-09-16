"""
make seed — populate the audit history, so /audit opens on a system that has been running.

Runs the demo questions through the real agent: real retrieval, real tools, real spans.
In demo mode the model responses come from recordings (make record); otherwise they are
live. One question abstains and one injects a tool failure on purpose.
"""
import argparse
import os

import yaml

from app import _ensure_schema
from lens.agent.loop import run_agent
from lens.config import get_settings
from lens.db import db_cursor
from lens.llm import question_hash

QUESTIONS_FILE = os.path.join(os.path.dirname(__file__), 'questions.yaml')


def load_questions():
    with open(QUESTIONS_FILE, encoding='utf-8') as f:
        return yaml.safe_load(f)['questions']


def already_run(question):
    with db_cursor() as cur:
        cur.execute("SELECT count(*) AS n FROM runs WHERE question_hash = %s AND status <> 'running'",
                    (question_hash(question),))
        return cur.fetchone()['n'] > 0


def main():
    parser = argparse.ArgumentParser(description='Seed the audit history with demo conversations')
    parser.add_argument('--force', action='store_true', help='run questions again even if they already exist')
    args = parser.parse_args()

    settings = get_settings()
    _ensure_schema()
    print(f"Seeding ({'demo mode — replaying recordings' if settings.demo_mode else 'live Azure OpenAI'})")

    for entry in load_questions():
        if not args.force and already_run(entry['question']):
            print(f"  {entry['key']:<24} skipped (already in the history)")
            continue
        summary = run_agent(entry['question'], settings, fault_injection=entry.get('fault_injection'))
        detail = summary.get('abstain_reason') or summary.get('error') or f"{len(summary['citations'])} citations"
        print(f"  {entry['key']:<24} {summary['status']:<10} {summary['latency_ms']:>6} ms  {detail}")


if __name__ == '__main__':
    main()
