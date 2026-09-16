"""Run records — one per user turn, stamped with the configuration and prompts that produced it."""
from lens.agent.prompts import register_bundle
from lens.db import db_cursor
from lens.llm import question_hash
from lens.tracing.tracer import new_trace_id, to_jsonb, utcnow


def start(question, settings, prompts, bundle_hash, conversation_id=None, replay_of=None, fault_injection=None):
    trace_id = new_trace_id()
    with db_cursor(commit=True) as cur:
        prompt_version_id = register_bundle(cur, prompts, bundle_hash)
        if conversation_id is None:
            cur.execute('INSERT INTO conversations (title, model) VALUES (%s, %s) RETURNING id',
                        (question[:120], settings.chat_model))
            conversation_id = str(cur.fetchone()['id'])
        cur.execute(
            """
            INSERT INTO runs (conversation_id, user_message, question_hash, status, prompt_version_id,
                              model, llm_source, config_json, config_hash, replay_of_run_id,
                              fault_injection, started_at, trace_id)
            VALUES (%s, %s, %s, 'running', %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, started_at
            """,
            (conversation_id, question, question_hash(question), prompt_version_id, settings.chat_model,
             'recording' if settings.demo_mode else 'live', to_jsonb(settings.snapshot()), settings.snapshot_hash(),
             replay_of, to_jsonb(fault_injection), utcnow(), trace_id),
        )
        row = cur.fetchone()
    return {'id': str(row['id']), 'conversation_id': str(conversation_id), 'trace_id': trace_id,
            'started_at': row['started_at'], 'config_hash': settings.snapshot_hash(),
            'prompt_version': bundle_hash, 'model': settings.chat_model,
            'replay_of_run_id': str(replay_of) if replay_of else None}


def finish(tracer, run, outcome):
    """Close the run: totals derived from its own LLM spans, plus the span that failed, if any."""
    totals = tracer.totals() or {}
    ended = utcnow()
    latency_ms = int((ended - run['started_at']).total_seconds() * 1000)
    failed_span = None
    with db_cursor(commit=True) as cur:
        if outcome['status'] == 'error':
            cur.execute("""SELECT name, error FROM spans WHERE run_id = %s AND status = 'error'
                           ORDER BY sequence DESC LIMIT 1""", (run['id'],))
            failed_span = cur.fetchone()
        cur.execute(
            """
            UPDATE runs SET final_answer = %s, status = %s, abstain_reason = %s, error = %s, confidence = %s,
                            ended_at = %s, latency_ms = %s, input_tokens = %s, output_tokens = %s, cost_usd = %s
             WHERE id = %s
            """,
            (outcome.get('answer'), outcome['status'], outcome.get('abstain_reason'), outcome.get('error'),
             outcome.get('confidence'), ended, latency_ms, totals.get('input_tokens'), totals.get('output_tokens'),
             totals.get('cost_usd'), run['id']),
        )
        cur.execute("""SELECT DISTINCT tc.tool_name FROM tool_calls tc JOIN spans s ON s.id = tc.span_id
                        WHERE s.run_id = %s ORDER BY tc.tool_name""", (run['id'],))
        tools_called = [r['tool_name'] for r in cur.fetchall()]
    return {
        'run_id': run['id'], 'conversation_id': run['conversation_id'], 'trace_id': run['trace_id'],
        'status': outcome['status'], 'answer': outcome.get('answer'), 'citations': outcome.get('citations', []),
        'confidence': outcome.get('confidence'), 'abstain_reason': outcome.get('abstain_reason'),
        'error': outcome.get('error'),
        'failed_span': {'name': failed_span['name'], 'error': failed_span['error']} if failed_span else None,
        'latency_ms': latency_ms, 'input_tokens': totals.get('input_tokens'),
        'output_tokens': totals.get('output_tokens'),
        'cost_usd': float(totals.get('cost_usd') or 0), 'tools_called': tools_called,
        'model': run['model'], 'prompt_version': run['prompt_version'],
        'config_hash': run['config_hash'], 'replay_of_run_id': run['replay_of_run_id'],
    }
