"""
Lens API — Flask + PostgreSQL (see the backend-conventions skill).

Routes live here and stay thin. The agent, retrieval, tracing, ingest and evaluation code
lives in the `lens` package: a single file for all of it would not be readable, which is
the opposite of the point of this application.
"""
import json
import logging
import queue
import threading
import uuid
from datetime import date, datetime
from decimal import Decimal

from dotenv import load_dotenv
from flask import Flask, Response, g, jsonify, request
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from lens.config import ConfigError, get_settings  # noqa: E402

try:
    SETTINGS = get_settings()
except ConfigError as e:
    # Fail loudly and specifically: the container must not start half-configured.
    logger.critical(f'Lens cannot start — {e}')
    raise SystemExit(f'Lens cannot start — {e}')

from lens import audit, auth  # noqa: E402
from lens.agent.loop import MEMORY_TURNS, run_agent  # noqa: E402
from lens.agent.prompts import load_bundle  # noqa: E402
from lens.agent.tools import openai_tools  # noqa: E402
from lens.corpus import load_manifest  # noqa: E402
from lens.db import get_db_connection  # noqa: E402
from lens.llm import calls_from_spans  # noqa: E402

# One evaluation at a time: two batches would interleave their agent runs and write
# overlapping rows into `evals`.
_EVAL_LOCK = threading.Lock()


def _json_default(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    return str(value)


class LensJSON(DefaultJSONProvider):
    @staticmethod
    def default(value):
        return _json_default(value)


app = Flask(__name__)
app.json = LensJSON(app)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

# Open CORS: the browser reaches the API through the nginx proxy on the same origin.
CORS(app, resources={r"/api/*": {"origins": "*"}})

# One gate in front of the whole API. In PROD every route but /api/health and
# /api/auth/config needs a valid Entra access token; in DEV it is a no-op. See lens/auth.py.
app.before_request(auth.enforce)

if auth.auth_enabled(SETTINGS):
    logger.info(f'Sign-in: Entra ID enforced (tenant {SETTINGS.entra_tenant_id}, '
                f'audience api://{SETTINGS.entra_api_client_id}, scope {SETTINGS.entra_api_scope}).')
else:
    # Loud on purpose. An unauthenticated API must never be a quiet default.
    logger.warning('Sign-in: BYPASSED — LENS_ENV_TYPE is DEV, so every API route is open. '
                   'Set LENS-ENV-TYPE to PROD in the Key Vault to enforce Entra sign-in.')


# =============================================================================
# SCHEMA MIGRATION (idempotent — mirrors database/sql_init.sql)
# =============================================================================
# The Postgres entrypoint applies database/sql_init.sql only on a FRESH data volume.
# This block keeps an existing database up to date and must stay in sync with that file.
# See the db-migrations skill.
_SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(64) UNIQUE NOT NULL,
    short_name VARCHAR(64),
    title TEXT NOT NULL,
    publisher TEXT,
    source_url TEXT,
    version TEXT,
    licence_note TEXT,
    retrieved_at TIMESTAMPTZ,
    sha256 CHAR(64),
    content_type TEXT,
    bytes BIGINT,
    page_count INT,
    embedding_model TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    status_detail TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_documents_updated_at ON documents;
CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS sections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    document_sha256 CHAR(64) NOT NULL,
    section_path TEXT NOT NULL,
    heading TEXT,
    level INT NOT NULL,
    ordinal INT NOT NULL,
    page_start INT,
    page_end INT,
    char_start INT NOT NULL,
    char_end INT NOT NULL,
    text TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    section_id UUID REFERENCES sections(id) ON DELETE SET NULL,
    document_sha256 CHAR(64) NOT NULL,
    section_path TEXT NOT NULL,
    ordinal INT NOT NULL,
    page_no INT,
    char_start INT NOT NULL,
    char_end INT NOT NULL,
    text TEXT NOT NULL,
    tokens INT,
    embedding vector(1536),
    embedding_model TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One ingest run = one batch id. Activation is keyed on it, not on the document hash:
-- re-parsing the same file (say, after a parser fix) must retire the previous chunks
-- even though the source bytes are identical.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS ingest_batch UUID;
ALTER TABLE chunks   ADD COLUMN IF NOT EXISTS ingest_batch UUID;

CREATE TABLE IF NOT EXISTS prompt_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    hash VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, hash)
);

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
CREATE TRIGGER update_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_message TEXT NOT NULL,
    question_hash VARCHAR(64),
    final_answer TEXT,
    status VARCHAR(20) NOT NULL,
    abstain_reason TEXT,
    error TEXT,
    confidence NUMERIC,
    prompt_version_id UUID REFERENCES prompt_versions(id),
    model TEXT,
    llm_source VARCHAR(20) NOT NULL DEFAULT 'live',
    config_json JSONB,
    config_hash VARCHAR(16),
    replay_of_run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
    fault_injection JSONB,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    latency_ms INT,
    input_tokens INT,
    output_tokens INT,
    cost_usd NUMERIC(10,6),
    trace_id VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS spans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    parent_span_id UUID REFERENCES spans(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type VARCHAR(20) NOT NULL,
    sequence INT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration_ms INT,
    status VARCHAR(20) NOT NULL,
    error TEXT,
    input_json JSONB,
    output_json JSONB,
    attributes_json JSONB
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    span_id UUID NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    arguments_json JSONB,
    result_json JSONB,
    ok BOOLEAN NOT NULL,
    error TEXT,
    duration_ms INT
);

CREATE TABLE IF NOT EXISTS retrieved_chunks (
    id BIGSERIAL PRIMARY KEY,
    span_id UUID NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES chunks(id),
    doc_id UUID NOT NULL REFERENCES documents(id),
    section_path TEXT,
    rank INT,
    score NUMERIC,
    retriever VARCHAR(20),
    used_in_answer BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS citations (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES chunks(id),
    doc_id UUID NOT NULL REFERENCES documents(id),
    marker VARCHAR(16),
    section_path TEXT,
    quote TEXT,
    char_start INT,
    char_end INT
);

CREATE TABLE IF NOT EXISTS guardrail_events (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    span_id UUID REFERENCES spans(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    verdict TEXT NOT NULL,
    detail_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evals (
    id BIGSERIAL PRIMARY KEY,
    batch_id UUID NOT NULL,
    run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
    question_key TEXT,
    metric TEXT NOT NULL,
    value NUMERIC,
    threshold NUMERIC,
    passed BOOLEAN,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100) WHERE active;
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_section_id ON chunks(section_id);
CREATE INDEX IF NOT EXISTS idx_sections_doc_id ON sections(doc_id);
CREATE INDEX IF NOT EXISTS idx_sections_doc_path ON sections(doc_id, section_path);
CREATE INDEX IF NOT EXISTS idx_runs_conversation_id ON runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_replay_of ON runs(replay_of_run_id);
CREATE INDEX IF NOT EXISTS idx_spans_run_id ON spans(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_span_id ON tool_calls(span_id);
CREATE INDEX IF NOT EXISTS idx_retrieved_chunks_span_id ON retrieved_chunks(span_id);
CREATE INDEX IF NOT EXISTS idx_retrieved_chunks_chunk_id ON retrieved_chunks(chunk_id);
CREATE INDEX IF NOT EXISTS idx_citations_run_id ON citations(run_id);
CREATE INDEX IF NOT EXISTS idx_citations_chunk_id ON citations(chunk_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_run_id ON guardrail_events(run_id);
CREATE INDEX IF NOT EXISTS idx_evals_batch_id ON evals(batch_id);
CREATE INDEX IF NOT EXISTS idx_evals_run_id ON evals(run_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_created_at ON prompt_versions(created_at DESC);
"""

_schema_ready = False


def _ensure_schema():
    """Run the idempotent schema migration once per process."""
    global _schema_ready
    if _schema_ready:
        return
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(_SCHEMA_SQL)
        conn.commit()
        cur.close()
        conn.close()
        _schema_ready = True
    except Exception as e:
        # Retry on the next request if the DB wasn't ready yet.
        logger.error(f"Schema migration failed (will retry): {str(e)}")


# =============================================================================
# HELPERS
# =============================================================================
def _uuid(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return None


def _sse(event, data):
    return f'event: {event}\ndata: {json.dumps(data, default=_json_default)}\n\n'


def _agent_stream(**kwargs):
    """Run the agent on a worker thread and stream its events; the run finishes (and the
    trace completes) even if the browser disconnects."""
    events = queue.Queue()

    def emit(event, data):
        events.put((event, data))

    def worker():
        try:
            run_agent(settings=SETTINGS, emit=emit, **kwargs)
        except Exception as e:
            logger.error(f'Agent run failed before it could be traced: {str(e)}')
            events.put(('error', {'message': 'The run could not be started. Check the backend logs.'}))
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def generate():
        yield ': open\n\n'
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                yield ': keep-alive\n\n'
                continue
            if item is None:
                break
            yield _sse(*item)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'})


# =============================================================================
# SIGN-IN
# =============================================================================
@app.route('/api/auth/config', methods=['GET'])
def auth_config():
    """
    How to sign in — the one route that answers before a token exists.

    The browser asks this first and builds its MSAL client from the answer, so the tenant,
    the client id and the scope live in one place (the Key Vault) rather than being baked
    into the frontend image at build time. Everything returned is public by nature: this
    flow (authorization code with PKCE) uses no client secret at all.
    """
    return jsonify(auth.public_config(SETTINGS)), 200


@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    """Who the API thinks is calling, after validating the token it was given."""
    identity = getattr(g, 'identity', None)
    if not identity:
        return jsonify({'error': 'Sign in to use this endpoint.', 'code': 'unauthenticated'}), 401
    return jsonify({'identity': identity,
                    'mode': 'entra' if auth.auth_enabled(SETTINGS) else 'open'}), 200


# =============================================================================
# HEALTH
# =============================================================================
@app.route('/api/health', methods=['GET'])
def health_check():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT 1')
        cur.close()
        conn.close()
        return jsonify({'status': 'healthy', 'database': 'connected',
                        'auth': 'entra' if auth.auth_enabled(SETTINGS) else 'bypassed',
                        'env_type': SETTINGS.env_type}), 200
    except Exception as e:
        return jsonify({'status': 'unhealthy', 'error': str(e)}), 500


@app.route('/api/meta', methods=['GET'])
def meta():
    try:
        _ensure_schema()
        prompts, bundle_hash = load_bundle()
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        vector_version = (cur.fetchone() or {}).get('extversion')
        cur.execute("SELECT count(*) AS n FROM chunks WHERE active AND embedding IS NOT NULL")
        embedded = cur.fetchone()['n']
        cur.close()
        conn.close()
        return jsonify({
            'demo_mode': SETTINGS.demo_mode,
            'config': SETTINGS.snapshot(),
            'config_hash': SETTINGS.snapshot_hash(),
            'prompt_bundle': bundle_hash,
            'prompts': {name: p.hash for name, p in prompts.items()},
            'pgvector': vector_version,
            'corpus_ready': embedded > 0,
            'embedded_chunks': embedded,
        }), 200
    except Exception as e:
        logger.error(f'Meta error: {str(e)}')
        return jsonify({'error': 'Failed to read service metadata'}), 500


# =============================================================================
# ASK — one agent run per turn, streamed over SSE
# =============================================================================
def _history(raw):
    """
    The client's view of the thread, accepted only in the shape the agent will use.

    Trimmed to MEMORY_TURNS messages here as well as in the loop: this is a public
    endpoint, and the cap is what stops an oversized body becoming an oversized prompt.
    Anything that is not a well-formed user/assistant message is dropped rather than
    rejected — a malformed tail should cost the follow-up its context, not its answer.
    """
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[-MEMORY_TURNS:]:
        if not isinstance(item, dict):
            continue
        role = item.get('role')
        content = item.get('content')
        if role not in ('user', 'assistant') or not isinstance(content, str):
            continue
        content = content.strip()
        if content:
            out.append({'role': role, 'content': content[:2000]})
    return out


@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        _ensure_schema()
        data = request.get_json() or {}
        question = (data.get('question') or '').strip()
        if not question:
            return jsonify({'error': 'A question is required'}), 400
        if len(question) > 2000:
            return jsonify({'error': 'Question is too long (2000 characters maximum)'}), 400
        conversation_id = None
        if data.get('conversation_id'):
            conversation_id = _uuid(data['conversation_id'])
            if not conversation_id:
                return jsonify({'error': 'Invalid conversation_id'}), 400
        history = _history(data.get('history'))
        return _agent_stream(question=question, conversation_id=conversation_id, history=history)
    except Exception as e:
        logger.error(f'Chat error: {str(e)}')
        return jsonify({'error': 'Failed to start the run'}), 500


@app.route('/api/runs/<run_id>/replay', methods=['POST'])
def replay_run(run_id):
    """
    Two different questions, deliberately kept apart.

      mode=reproduce (default)  Re-execute the pipeline against the model responses this
                                run recorded. Retrieval, tools, guardrails and citation
                                verification all run again for real; only the sampled part
                                is served from the trace. The answer must come out
                                identical, and the run reports whether it did. This is the
                                reproducibility check.

      mode=live                 Ask the question again against the current prompts and
                                configuration. The answer may legitimately differ — that
                                difference is the change-control signal.
    """
    try:
        _ensure_schema()
        run_uuid = _uuid(run_id)
        if not run_uuid:
            return jsonify({'error': 'Invalid run id'}), 404
        mode = (request.args.get('mode') or (request.get_json(silent=True) or {}).get('mode')
                or 'reproduce').lower()
        if mode not in ('reproduce', 'live'):
            return jsonify({'error': "mode must be 'reproduce' or 'live'"}), 400

        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""SELECT id, user_message, conversation_id, fault_injection, final_answer, status
                         FROM runs WHERE id = %s""", (run_uuid,))
        run = cur.fetchone()
        spans, citations = [], []
        if run and mode == 'reproduce':
            cur.execute("""SELECT name, type, input_json, output_json, duration_ms
                             FROM spans WHERE run_id = %s ORDER BY sequence""", (run_uuid,))
            spans = cur.fetchall()
            cur.execute("""SELECT marker, chunk_id, char_start, char_end
                             FROM citations WHERE run_id = %s ORDER BY id""", (run_uuid,))
            citations = cur.fetchall()
        cur.close()
        conn.close()
        if not run:
            return jsonify({'error': 'Not found'}), 404

        extra = {}
        if mode == 'reproduce':
            calls = calls_from_spans(spans)
            if not calls:
                return jsonify({'error': 'This run has no recorded model responses to reproduce from. '
                                         'Re-run it against the current prompts instead.'}), 409
            extra = {
                'replay_calls': calls,
                'expect': {'run_id': str(run['id']), 'answer': run['final_answer'],
                           'status': run['status'], 'citations': [dict(c) for c in citations]},
            }

        return _agent_stream(question=run['user_message'], conversation_id=str(run['conversation_id']),
                             replay_of=run_uuid, fault_injection=run['fault_injection'], **extra)
    except Exception as e:
        logger.error(f'Replay error: {str(e)}')
        return jsonify({'error': 'Failed to start the replay'}), 500


# =============================================================================
# AUDIT
# =============================================================================
@app.route('/api/runs', methods=['GET'])
def list_runs():
    try:
        _ensure_schema()
        return jsonify(audit.list_runs(
            status=request.args.get('status'),
            search=request.args.get('q'),
            tool=request.args.get('tool'),
            framework=request.args.get('framework'),
            date_from=request.args.get('from'),
            date_to=request.args.get('to'),
            limit=request.args.get('limit', 50),
            offset=request.args.get('offset', 0),
        )), 200
    except Exception as e:
        logger.error(f'List runs error: {str(e)}')
        return jsonify({'error': 'Failed to list runs'}), 500


@app.route('/api/conversations', methods=['GET'])
def list_conversations():
    """The same history as /api/runs, grouped into threads. Identical filter semantics."""
    try:
        _ensure_schema()
        return jsonify(audit.list_conversations(
            status=request.args.get('status'),
            search=request.args.get('q'),
            tool=request.args.get('tool'),
            framework=request.args.get('framework'),
            date_from=request.args.get('from'),
            date_to=request.args.get('to'),
            limit=request.args.get('limit', 25),
            offset=request.args.get('offset', 0),
        )), 200
    except Exception as e:
        logger.error(f'List conversations error: {str(e)}')
        return jsonify({'error': 'Failed to list conversations'}), 500


@app.route('/api/conversations/<conversation_id>', methods=['GET'])
def get_conversation(conversation_id):
    try:
        _ensure_schema()
        conversation_uuid = _uuid(conversation_id)
        thread = audit.get_thread(conversation_uuid) if conversation_uuid else None
        if not thread:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(thread), 200
    except Exception as e:
        logger.error(f'Get conversation error: {str(e)}')
        return jsonify({'error': 'Failed to load the conversation'}), 500


@app.route('/api/runs/<run_id>', methods=['GET'])
def get_run(run_id):
    try:
        _ensure_schema()
        run_uuid = _uuid(run_id)
        trace = audit.get_trace(run_uuid) if run_uuid else None
        if not trace:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(trace), 200
    except Exception as e:
        logger.error(f'Get run error: {str(e)}')
        return jsonify({'error': 'Failed to load the trace'}), 500


@app.route('/api/runs/<run_id>/export', methods=['GET'])
def export_run(run_id):
    try:
        _ensure_schema()
        run_uuid = _uuid(run_id)
        payload = audit.build_export(run_uuid) if run_uuid else None
        if not payload:
            return jsonify({'error': 'Not found'}), 404
        body = json.dumps(payload, indent=2, default=_json_default)
        return Response(body, mimetype='application/json', headers={
            'Content-Disposition': f'attachment; filename="lens-audit-{run_id}.json"'})
    except Exception as e:
        logger.error(f'Export error: {str(e)}')
        return jsonify({'error': 'Failed to build the audit pack'}), 500


@app.route('/api/chunks/<chunk_id>/context', methods=['GET'])
def chunk_context(chunk_id):
    try:
        _ensure_schema()
        chunk_uuid = _uuid(chunk_id)
        context = audit.get_chunk_context(chunk_uuid) if chunk_uuid else None
        if not context:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(context), 200
    except Exception as e:
        logger.error(f'Chunk context error: {str(e)}')
        return jsonify({'error': 'Failed to load the source text'}), 500


# =============================================================================
# CORPUS, PROMPTS, TOOLS, EVALS
# =============================================================================
@app.route('/api/corpus', methods=['GET'])
def corpus():
    try:
        _ensure_schema()
        return jsonify({'documents': audit.list_corpus(), 'manifest_count': len(load_manifest())}), 200
    except Exception as e:
        logger.error(f'Corpus error: {str(e)}')
        return jsonify({'error': 'Failed to list the corpus'}), 500


@app.route('/api/prompts', methods=['GET'])
def prompts():
    try:
        _ensure_schema()
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT id, name, hash, content, created_at FROM prompt_versions ORDER BY name, created_at DESC')
        rows = cur.fetchall()
        cur.close()
        conn.close()
        current, bundle_hash = load_bundle()
        return jsonify({'versions': rows, 'current': {name: p.hash for name, p in current.items()},
                        'current_bundle': bundle_hash}), 200
    except Exception as e:
        logger.error(f'Prompts error: {str(e)}')
        return jsonify({'error': 'Failed to list prompt versions'}), 500


@app.route('/api/tools', methods=['GET'])
def tools():
    return jsonify({'tools': openai_tools()}), 200


@app.route('/api/evals', methods=['GET'])
def evals():
    try:
        _ensure_schema()
        batch_id = request.args.get('batch_id')
        if batch_id and not _uuid(batch_id):
            return jsonify({'error': 'Invalid batch id'}), 400
        payload = audit.list_evals(batch_id)
        # What a run would involve, so the screen can say so before starting one.
        try:
            from lens.evals.run import load_spec
            spec = load_spec()
            payload['question_set'] = {
                'count': len(spec.get('questions') or []),
                'thresholds': spec.get('thresholds') or {},
            }
        except Exception:
            payload['question_set'] = None
        payload['running'] = _EVAL_LOCK.locked()
        return jsonify(payload), 200
    except Exception as e:
        logger.error(f'Evals error: {str(e)}')
        return jsonify({'error': 'Failed to load evaluation results'}), 500


@app.route('/api/evals/run', methods=['POST'])
def run_evals():
    """
    Start an evaluation and stream its progress.

    The same `run_batch` that `make eval` calls, so the button and the command line
    cannot drift. One at a time: a second request while a batch is running is refused
    rather than queued, because two batches would interleave their agent runs.
    """
    if not _EVAL_LOCK.acquire(blocking=False):
        return jsonify({'error': 'An evaluation is already running.'}), 409

    events = queue.Queue()

    def worker():
        try:
            _ensure_schema()
            from lens.evals.run import run_batch
            run_batch(emit=lambda event, data: events.put((event, data)))
        except Exception as e:
            logger.error(f'Eval batch failed: {str(e)}')
            events.put(('error', {'message': f'The evaluation stopped: {e.__class__.__name__}. '
                                             'Check the backend logs.'}))
        finally:
            _EVAL_LOCK.release()
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def generate():
        yield ': open\n\n'
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                yield ': keep-alive\n\n'
                continue
            if item is None:
                break
            yield _sse(*item)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=SETTINGS.demo_mode is False and False)
