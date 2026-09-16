"""
Span tracer — the audit trail.

One run per user turn; spans form a tree (agent → llm / tool → retrieval → llm …).
Instrumenting a step is one line:

    with tracer.span("retrieval.hybrid", type="retrieval", attributes={"query": q}) as span:
        results = hybrid_search(q, k)
        span.set_output({"n": len(results)})

Guarantees:
  * a span row is INSERTed when the step starts (status=running) and UPDATEd when it
    ends — so a crash mid-step still leaves the span in the trace, marked as such;
  * exceptions mark the span `error` with the message, then propagate;
  * writes use their own autocommit connection, independent of any business
    transaction, so a failed run can never roll its own trace back;
  * if the trace cannot be written, the step does not run (span open fails first).
"""
import json
import logging
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

from psycopg2.extras import Json, execute_values

from lens.db import get_db_connection

logger = logging.getLogger(__name__)

SPAN_TYPES = ('agent', 'llm', 'retrieval', 'tool', 'guardrail')


def utcnow():
    return datetime.now(timezone.utc)


def to_jsonb(value):
    """Round-trip through json so UUIDs, Decimals and datetimes persist predictably."""
    if value is None:
        return None
    return Json(json.loads(json.dumps(value, default=str)))


def new_trace_id():
    return secrets.token_hex(16)   # 32 hex chars — a valid W3C / OpenTelemetry trace id


class Span:
    def __init__(self, span_id, name, kind, parent_id, sequence, input_, attributes):
        self.id = span_id
        self.name = name
        self.type = kind
        self.parent_id = parent_id
        self.sequence = sequence
        self.input = input_
        self.attributes = dict(attributes or {})
        self.output = None
        self.status = 'ok'
        self.error = None

    def set_input(self, value):
        self.input = value

    def set_output(self, value):
        self.output = value

    def set_attributes(self, **attributes):
        self.attributes.update(attributes)

    def fail(self, message):
        """Mark the span failed without raising (e.g. a tool error handed back to the agent)."""
        self.status = 'error'
        self.error = message


class RunTracer:
    def __init__(self, run_id, trace_id):
        self.run_id = str(run_id)
        self.trace_id = trace_id
        self._conn = get_db_connection()
        self._conn.autocommit = True
        self._lock = threading.Lock()
        self._sequence = 0
        self._local = threading.local()

    # ── low level ────────────────────────────────────────────────────────────
    def _execute(self, sql, params, fetch=False, many=False):
        with self._lock:
            cur = self._conn.cursor()
            try:
                if many:
                    execute_values(cur, sql, params)
                    return None
                cur.execute(sql, params)
                return cur.fetchone() if fetch else None
            finally:
                cur.close()

    def _stack(self):
        if not hasattr(self._local, 'stack'):
            self._local.stack = []
        return self._local.stack

    def current(self):
        stack = self._stack()
        return stack[-1] if stack else None

    def close(self):
        try:
            self._conn.close()
        except Exception:
            pass

    # ── spans ────────────────────────────────────────────────────────────────
    @contextmanager
    def span(self, name, type, parent=None, input=None, attributes=None):   # noqa: A002 — mirrors the span model
        kind = type
        if kind not in SPAN_TYPES:
            raise ValueError(f'unknown span type {kind!r}')
        parent = parent or self.current()
        with self._lock:
            self._sequence += 1
            sequence = self._sequence
        row = self._execute(
            """
            INSERT INTO spans (run_id, parent_span_id, name, type, sequence, started_at,
                               status, input_json, attributes_json)
            VALUES (%s, %s, %s, %s, %s, %s, 'running', %s, %s)
            RETURNING id
            """,
            (self.run_id, parent.id if parent else None, name, kind, sequence, utcnow(),
             to_jsonb(input), to_jsonb(attributes or {})),
            fetch=True,
        )
        span = Span(str(row['id']), name, kind, parent.id if parent else None, sequence,
                    input, attributes)
        self._stack().append(span)
        started = time.perf_counter()
        try:
            yield span
        except Exception as e:
            span.status = 'error'
            span.error = span.error or f'{e.__class__.__name__}: {e}'
            raise
        finally:
            self._stack().pop()
            duration_ms = int((time.perf_counter() - started) * 1000)
            try:
                self._execute(
                    """
                    UPDATE spans
                       SET ended_at = %s, duration_ms = %s, status = %s, error = %s,
                           input_json = %s, output_json = %s, attributes_json = %s
                     WHERE id = %s
                    """,
                    (utcnow(), duration_ms, span.status, span.error, to_jsonb(span.input),
                     to_jsonb(span.output), to_jsonb(span.attributes), span.id),
                )
            except Exception as write_error:
                logger.error(f'Could not close span {span.id} ({name}): {write_error}')

    # ── span details ─────────────────────────────────────────────────────────
    def record_tool_call(self, span, tool_name, arguments, result, ok, error, duration_ms):
        self._execute(
            """
            INSERT INTO tool_calls (span_id, tool_name, arguments_json, result_json, ok, error, duration_ms)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (span.id, tool_name, to_jsonb(arguments), to_jsonb(result), ok, error, duration_ms),
        )

    def record_retrieved(self, span, candidates):
        """Persist EVERY candidate from every retriever — used or not."""
        if not candidates:
            return
        rows = [
            (span.id, c['chunk_id'], c['doc_id'], c['section_path'], c['rank'], c['score'], c['retriever'])
            for c in candidates
        ]
        self._execute(
            """
            INSERT INTO retrieved_chunks (span_id, chunk_id, doc_id, section_path, rank, score, retriever)
            VALUES %s
            """,
            rows,
            many=True,
        )

    def record_guardrail(self, span, kind, verdict, detail):
        self._execute(
            """
            INSERT INTO guardrail_events (run_id, span_id, kind, verdict, detail_json)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (self.run_id, span.id if span else None, kind, verdict, to_jsonb(detail)),
        )

    def mark_used(self, chunk_ids):
        if not chunk_ids:
            return
        self._execute(
            """
            UPDATE retrieved_chunks rc
               SET used_in_answer = TRUE
              FROM spans s
             WHERE rc.span_id = s.id AND s.run_id = %s AND rc.chunk_id = ANY(%s::uuid[])
            """,
            (self.run_id, list(chunk_ids)),
        )

    def record_citations(self, citations):
        if not citations:
            return
        rows = [
            (self.run_id, c['chunk_id'], c['doc_id'], c['marker'], c['section_path'], c['quote'],
             c.get('char_start'), c.get('char_end'))
            for c in citations
        ]
        self._execute(
            """
            INSERT INTO citations (run_id, chunk_id, doc_id, marker, section_path, quote, char_start, char_end)
            VALUES %s
            """,
            rows,
            many=True,
        )

    # ── run totals, derived from the spans themselves ───────────────────────
    def totals(self):
        return self._execute(
            """
            SELECT COALESCE(SUM((attributes_json->>'input_tokens')::int), 0)  AS input_tokens,
                   COALESCE(SUM((attributes_json->>'output_tokens')::int), 0) AS output_tokens,
                   COALESCE(SUM((attributes_json->>'cost_usd')::numeric), 0)  AS cost_usd
              FROM spans
             WHERE run_id = %s AND type = 'llm'
            """,
            (self.run_id,),
            fetch=True,
        )
