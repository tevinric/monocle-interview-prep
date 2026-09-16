"""
Audit queries — the conversation list, one run's whole trace, and the export pack.

These are ordinary SQL over the tracing tables; they are worth reading, because they are
the proof that the trace is a queryable record rather than a log file.
"""
import hashlib
import json

from lens.db import db_cursor

# The filter clause and the summary columns are shared by the flat run list and the
# conversation-grouped list, so the two views can never disagree about what a filter means.
_RUN_FILTERS = """
       (%(status)s::text IS NULL OR r.status = %(status)s)
   AND (%(search)s::text IS NULL OR r.user_message ILIKE %(search)s ESCAPE '\\')
   AND (%(date_from)s::date IS NULL OR r.started_at >= %(date_from)s::date)
   AND (%(date_to)s::date IS NULL OR r.started_at < %(date_to)s::date + 1)
   AND (%(tool)s::text IS NULL OR EXISTS (SELECT 1 FROM tool_calls tc JOIN spans s ON s.id = tc.span_id
                                           WHERE s.run_id = r.id AND tc.tool_name = %(tool)s))
   AND (%(framework)s::text IS NULL OR EXISTS (SELECT 1 FROM citations c JOIN documents d ON d.id = c.doc_id
                                                WHERE c.run_id = r.id AND d.key = %(framework)s))
"""

_RUN_SUMMARY_COLUMNS = """
       r.id, r.conversation_id, r.started_at, r.user_message, r.status, r.confidence,
       r.latency_ms, r.input_tokens, r.output_tokens, r.cost_usd, r.model,
       r.llm_source, r.replay_of_run_id, r.error, r.abstain_reason,
       COALESCE((SELECT array_agg(DISTINCT tc.tool_name) FROM tool_calls tc
                   JOIN spans s ON s.id = tc.span_id WHERE s.run_id = r.id), '{}') AS tools_used,
       (SELECT count(DISTINCT rc.chunk_id) FROM retrieved_chunks rc
          JOIN spans s ON s.id = rc.span_id WHERE s.run_id = r.id) AS chunks_retrieved,
       (SELECT count(*) FROM citations c WHERE c.run_id = r.id) AS citation_count,
       COALESCE((SELECT array_agg(DISTINCT d.short_name) FROM citations c
                   JOIN documents d ON d.id = c.doc_id WHERE c.run_id = r.id), '{}') AS frameworks_cited
"""

RUN_LIST_SQL = f"""
SELECT {_RUN_SUMMARY_COLUMNS}
  FROM runs r
 WHERE {_RUN_FILTERS}
 ORDER BY r.started_at DESC
 LIMIT %(limit)s OFFSET %(offset)s
"""

# A conversation is selected when ANY of its turns matches the filters; every turn of a
# selected conversation is then returned, because a thread read with its middle removed is
# not an audit trail. The turns that matched carry `matched` so the screen can say which.
CONVERSATION_LIST_SQL = f"""
SELECT c.id, c.title, c.model, c.created_at,
       count(r.id) AS turn_count,
       min(r.started_at) AS first_at,
       max(r.started_at) AS last_at,
       sum(r.cost_usd) AS cost_usd,
       sum(r.latency_ms) AS latency_ms,
       sum(COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0)) AS tokens,
       count(*) FILTER (WHERE r.status = 'error') AS error_count,
       count(*) FILTER (WHERE r.status = 'abstained') AS abstained_count,
       count(*) FILTER (WHERE r.replay_of_run_id IS NOT NULL) AS replay_count,
       COALESCE((SELECT array_agg(DISTINCT d.short_name) FROM citations ci
                   JOIN documents d ON d.id = ci.doc_id
                   JOIN runs r2 ON r2.id = ci.run_id
                  WHERE r2.conversation_id = c.id), '{{}}') AS frameworks_cited
  FROM conversations c
  JOIN runs r ON r.conversation_id = c.id
 WHERE c.id IN (SELECT r.conversation_id FROM runs r WHERE {_RUN_FILTERS})
 GROUP BY c.id
 ORDER BY max(r.started_at) DESC
 LIMIT %(limit)s OFFSET %(offset)s
"""

CONVERSATION_TURNS_SQL = f"""
SELECT {_RUN_SUMMARY_COLUMNS},
       row_number() OVER (PARTITION BY r.conversation_id ORDER BY r.started_at, r.id) AS turn,
       ({_RUN_FILTERS}) AS matched
  FROM runs r
 WHERE r.conversation_id = ANY(%(conversation_ids)s::uuid[])
 ORDER BY r.conversation_id, r.started_at, r.id
"""

CONVERSATION_COUNT_SQL = f"""
SELECT count(DISTINCT r.conversation_id) AS n FROM runs r WHERE {_RUN_FILTERS}
"""


def _like(value):
    if not value:
        return None
    escaped = value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'%{escaped}%'


def list_runs(status=None, search=None, tool=None, framework=None, date_from=None, date_to=None,
              limit=50, offset=0):
    params = {'status': status, 'search': _like(search), 'tool': tool, 'framework': framework,
              'date_from': date_from, 'date_to': date_to, 'limit': min(int(limit), 200), 'offset': int(offset)}
    with db_cursor() as cur:
        cur.execute(RUN_LIST_SQL, params)
        rows = cur.fetchall()
        cur.execute('SELECT count(*) AS n FROM runs')
        total = cur.fetchone()['n']
    return {'runs': rows, 'total': total}


def list_conversations(status=None, search=None, tool=None, framework=None, date_from=None, date_to=None,
                       limit=25, offset=0):
    """
    The same history, grouped into the threads it was actually asked in.

    One row per conversation, with every turn of that conversation nested under it in the
    order it was asked. Each turn keeps the full summary the flat list shows, so a turn is
    no less auditable for being grouped — it is only placed in its context.
    """
    params = {'status': status, 'search': _like(search), 'tool': tool, 'framework': framework,
              'date_from': date_from, 'date_to': date_to,
              'limit': min(int(limit), 100), 'offset': int(offset)}
    with db_cursor() as cur:
        cur.execute(CONVERSATION_LIST_SQL, params)
        conversations = cur.fetchall()
        turns = []
        if conversations:
            cur.execute(CONVERSATION_TURNS_SQL,
                        dict(params, conversation_ids=[str(c['id']) for c in conversations]))
            turns = cur.fetchall()
        cur.execute(CONVERSATION_COUNT_SQL, params)
        total = cur.fetchone()['n']
        cur.execute('SELECT count(*) AS n FROM runs')
        total_runs = cur.fetchone()['n']

    by_conversation = {}
    for turn in turns:
        by_conversation.setdefault(str(turn['conversation_id']), []).append(turn)
    for conversation in conversations:
        conversation['turns'] = by_conversation.get(str(conversation['id']), [])
        conversation['matched_count'] = sum(1 for t in conversation['turns'] if t['matched'])
    return {'conversations': conversations, 'total': total, 'total_runs': total_runs}


def get_thread(conversation_id, run_id=None):
    """Every turn of one conversation, newest last — the thread strip on a trace page."""
    with db_cursor() as cur:
        cur.execute('SELECT id, title, model, created_at FROM conversations WHERE id = %s', (conversation_id,))
        conversation = cur.fetchone()
        if not conversation:
            return None
        cur.execute(
            """
            SELECT id, conversation_id, started_at, user_message, status, confidence, latency_ms,
                   input_tokens, output_tokens, cost_usd, replay_of_run_id, abstain_reason,
                   row_number() OVER (ORDER BY started_at, id) AS turn
              FROM runs WHERE conversation_id = %s ORDER BY started_at, id
            """, (conversation_id,))
        turns = cur.fetchall()
    for turn in turns:
        turn['is_current'] = run_id is not None and str(turn['id']) == str(run_id)
    return {'conversation': conversation, 'turns': turns}


def get_trace(run_id):
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT r.*, c.title AS conversation_title, pv.hash AS prompt_bundle_hash, pv.content AS prompt_bundle
              FROM runs r
              JOIN conversations c ON c.id = r.conversation_id
              LEFT JOIN prompt_versions pv ON pv.id = r.prompt_version_id
             WHERE r.id = %s
            """, (run_id,))
        run = cur.fetchone()
        if not run:
            return None

        cur.execute('SELECT * FROM spans WHERE run_id = %s ORDER BY sequence', (run_id,))
        spans = cur.fetchall()
        cur.execute("""SELECT tc.* FROM tool_calls tc JOIN spans s ON s.id = tc.span_id
                        WHERE s.run_id = %s ORDER BY tc.id""", (run_id,))
        tool_calls = cur.fetchall()
        cur.execute(
            """
            SELECT rc.id, rc.span_id, rc.chunk_id, rc.rank, rc.score, rc.retriever, rc.used_in_answer,
                   rc.section_path, d.key AS doc_key, d.short_name, c.page_no,
                   left(c.text, 400) AS preview, length(c.text) AS text_length
              FROM retrieved_chunks rc
              JOIN spans s ON s.id = rc.span_id
              JOIN chunks c ON c.id = rc.chunk_id
              JOIN documents d ON d.id = rc.doc_id
             WHERE s.run_id = %s
             ORDER BY rc.span_id,
                      CASE rc.retriever WHEN 'fused' THEN 0 WHEN 'lookup' THEN 0 WHEN 'section' THEN 0
                                        WHEN 'dense' THEN 1 ELSE 2 END, rc.rank
            """, (run_id,))
        retrieved = cur.fetchall()
        cur.execute(
            """
            SELECT ci.*, d.key AS doc_key, d.short_name, d.title AS doc_title, d.source_url,
                   d.sha256 AS document_sha256, c.page_no
              FROM citations ci
              JOIN documents d ON d.id = ci.doc_id
              JOIN chunks c ON c.id = ci.chunk_id
             WHERE ci.run_id = %s ORDER BY ci.id
            """, (run_id,))
        citations = cur.fetchall()
        cur.execute('SELECT * FROM guardrail_events WHERE run_id = %s ORDER BY id', (run_id,))
        guardrail_events = cur.fetchall()
        cur.execute(
            """
            SELECT DISTINCT pv.name, pv.hash, pv.created_at
              FROM spans s JOIN prompt_versions pv
                ON pv.name = s.attributes_json->>'prompt_name' AND pv.hash = s.attributes_json->>'prompt_version'
             WHERE s.run_id = %s ORDER BY pv.name
            """, (run_id,))
        prompts_used = cur.fetchall()
        cur.execute("""SELECT id, started_at, status, confidence, cost_usd FROM runs
                        WHERE replay_of_run_id = %s ORDER BY started_at""", (run_id,))
        replays = cur.fetchall()

    by_span = {}
    for call in tool_calls:
        by_span.setdefault(str(call['span_id']), {'tool_calls': [], 'retrieved': []})['tool_calls'].append(call)
    for row in retrieved:
        by_span.setdefault(str(row['span_id']), {'tool_calls': [], 'retrieved': []})['retrieved'].append(row)
    for span in spans:
        detail = by_span.get(str(span['id']), {})
        span['tool_calls'] = detail.get('tool_calls', [])
        span['retrieved'] = detail.get('retrieved', [])

    thread = get_thread(run['conversation_id'], run_id) or {}

    return {'run': run, 'spans': spans, 'citations': citations, 'guardrail_events': guardrail_events,
            'prompts_used': prompts_used, 'replays': replays,
            'conversation': thread.get('conversation'), 'thread': thread.get('turns', [])}


def build_export(run_id):
    """The audit pack: everything needed to explain this answer in nine months' time."""
    trace = get_trace(run_id)
    if not trace:
        return None
    run = trace['run']
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT c.id AS chunk_id, d.key AS doc_key, d.short_name, c.section_path, c.page_no,
                   c.char_start, c.char_end, c.text, c.tokens, c.document_sha256
              FROM chunks c JOIN documents d ON d.id = c.doc_id
             WHERE c.id IN (SELECT rc.chunk_id FROM retrieved_chunks rc JOIN spans s ON s.id = rc.span_id
                             WHERE s.run_id = %s
                            UNION SELECT ci.chunk_id FROM citations ci WHERE ci.run_id = %s)
             ORDER BY d.key, c.char_start
            """, (run_id, run_id))
        chunks = cur.fetchall()
        cur.execute(
            """
            SELECT DISTINCT d.key, d.short_name, d.title, d.publisher, d.source_url, d.version,
                   d.licence_note, d.retrieved_at, d.sha256, d.status
              FROM documents d
             WHERE d.id IN (SELECT rc.doc_id FROM retrieved_chunks rc JOIN spans s ON s.id = rc.span_id
                             WHERE s.run_id = %s)
             ORDER BY d.key
            """, (run_id,))
        documents = cur.fetchall()
        cur.execute(
            """
            SELECT pv.name, pv.hash, pv.content FROM prompt_versions pv
             WHERE (pv.name, pv.hash) IN (
                   SELECT s.attributes_json->>'prompt_name', s.attributes_json->>'prompt_version'
                     FROM spans s WHERE s.run_id = %s AND s.attributes_json ? 'prompt_name')
                OR pv.id = %s
             ORDER BY pv.name
            """, (run_id, run['prompt_version_id']))
        prompts = cur.fetchall()

    from lens.agent.tools import openai_tools
    payload = {
        'export_format': 'lens.audit.v1',
        'run': run,
        'spans': trace['spans'],
        'citations': trace['citations'],
        'guardrail_events': trace['guardrail_events'],
        'evidence': chunks,
        'documents': documents,
        'prompts': prompts,
        'tool_contracts': openai_tools(),
        'replays': trace['replays'],
    }
    canonical = json.dumps(payload, sort_keys=True, default=str, separators=(',', ':'))
    payload['integrity'] = {'sha256': hashlib.sha256(canonical.encode()).hexdigest(),
                            'note': 'SHA-256 of this document with the integrity field removed.'}
    return payload


def get_chunk_context(chunk_id):
    """A chunk with the section text around it, for the evidence drawer."""
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT c.*, d.key AS doc_key, d.short_name, d.title AS doc_title, d.source_url, d.sha256
              FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id = %s
            """, (chunk_id,))
        chunk = cur.fetchone()
        if not chunk:
            return None
        cur.execute(
            """
            SELECT section_path, char_start, char_end, text FROM sections
             WHERE doc_id = %s AND active AND char_end > %s AND char_start < %s
             ORDER BY ordinal
            """, (chunk['doc_id'], chunk['char_start'], chunk['char_end']))
        sections = cur.fetchall()
    context = {'char_start': sections[0]['char_start'] if sections else chunk['char_start'],
               'text': '\n'.join(s['text'] for s in sections) if sections else chunk['text'],
               'section_paths': [s['section_path'] for s in sections]}
    chunk.pop('embedding', None)
    return {'chunk': chunk, 'context': context}


def list_corpus():
    from lens.corpus import load_manifest
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT d.*,
                   (SELECT count(*) FROM chunks c WHERE c.doc_id = d.id AND c.active) AS chunk_count,
                   (SELECT count(*) FROM chunks c WHERE c.doc_id = d.id AND c.active AND c.embedding IS NOT NULL)
                       AS embedded_count,
                   (SELECT count(*) FROM sections s WHERE s.doc_id = d.id AND s.active) AS section_count
              FROM documents d
            """)
        rows = {r['key']: r for r in cur.fetchall()}
    documents = []
    for entry in load_manifest():
        row = rows.get(entry['key'])
        if row:
            documents.append(row)
        else:
            documents.append({'key': entry['key'], 'short_name': entry['short_name'], 'title': entry['title'],
                              'publisher': entry['publisher'], 'source_url': entry['source_url'],
                              'version': entry['version'], 'licence_note': entry['licence_note'],
                              'status': 'not ingested', 'chunk_count': 0, 'embedded_count': 0, 'section_count': 0})
    return documents


def list_evals(batch_id=None):
    with db_cursor() as cur:
        cur.execute("""SELECT batch_id, min(created_at) AS created_at, count(*) FILTER (WHERE question_key IS NULL) AS metrics,
                              bool_and(COALESCE(passed, TRUE)) FILTER (WHERE question_key IS NULL) AS passed
                         FROM evals GROUP BY batch_id ORDER BY min(created_at) DESC LIMIT 20""")
        batches = cur.fetchall()
        if batch_id is None:
            batch_id = batches[0]['batch_id'] if batches else None
        rows = []
        if batch_id:
            cur.execute(
                """
                SELECT e.*, r.status AS run_status, r.user_message, r.latency_ms, r.cost_usd
                  FROM evals e LEFT JOIN runs r ON r.id = e.run_id
                 WHERE e.batch_id = %s ORDER BY e.question_key NULLS FIRST, e.metric
                """, (batch_id,))
            rows = cur.fetchall()
    return {'batches': batches, 'batch_id': batch_id,
            'summary': [r for r in rows if r['question_key'] is None],
            'questions': [r for r in rows if r['question_key'] is not None]}
