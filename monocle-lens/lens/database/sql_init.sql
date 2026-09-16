-- Applied ONCE by the Postgres entrypoint on a fresh data volume.
-- Keep every statement idempotent and mirror new tables/columns into the
-- _SCHEMA_SQL block in backend/app.py (see the db-migrations skill).
--
-- Trace timestamps are TIMESTAMPTZ: an audit trail must be unambiguous about time.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- Shared trigger to keep updated_at current on any table that has the column.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- =============================================================================
-- CORPUS: documents, sections, chunks
-- =============================================================================
-- Chunks are never deleted when a source document changes: the old version is
-- marked inactive, so every past trace still resolves to the exact text it cited.
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
    status VARCHAR(20) NOT NULL DEFAULT 'pending',      -- ok | unavailable | pending
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
    char_start INT NOT NULL,                             -- offsets into the normalised document text
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
    -- text-embedding-3-small is native at 1536 dimensions, within pgvector's 2,000-dim
    -- index limit. Changing the embedding model means changing this number here AND in
    -- the _SCHEMA_SQL block in backend/app.py, then re-ingesting.
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

-- =============================================================================
-- TRACING: prompt versions, conversations, runs, spans and their details
-- =============================================================================
CREATE TABLE IF NOT EXISTS prompt_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    hash VARCHAR(16) NOT NULL,                           -- first 8 chars of SHA-256
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
    user_message TEXT NOT NULL,                          -- stored AFTER PII redaction
    question_hash VARCHAR(64),
    final_answer TEXT,
    status VARCHAR(20) NOT NULL,                         -- running | ok | abstained | error
    abstain_reason TEXT,
    error TEXT,
    confidence NUMERIC,
    prompt_version_id UUID REFERENCES prompt_versions(id),
    model TEXT,
    llm_source VARCHAR(20) NOT NULL DEFAULT 'live',      -- live | recording (demo mode)
    config_json JSONB,                                   -- effective non-secret configuration
    config_hash VARCHAR(16),
    replay_of_run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
    fault_injection JSONB,                               -- set only for deliberate demo faults
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
    type VARCHAR(20) NOT NULL,                           -- agent | llm | retrieval | tool | guardrail
    sequence INT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration_ms INT,
    status VARCHAR(20) NOT NULL,                         -- running | ok | error
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
    retriever VARCHAR(20),                               -- dense | keyword | fused
    used_in_answer BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS citations (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES chunks(id),
    doc_id UUID NOT NULL REFERENCES documents(id),
    marker VARCHAR(16),                                  -- evidence handle used in the answer, e.g. E3
    section_path TEXT,
    quote TEXT,
    char_start INT,                                      -- quote offsets into the document text
    char_end INT
);

CREATE TABLE IF NOT EXISTS guardrail_events (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    span_id UUID REFERENCES spans(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                                  -- input_pii | groundedness | abstention
    verdict TEXT NOT NULL,
    detail_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- EVALUATION
-- =============================================================================
CREATE TABLE IF NOT EXISTS evals (
    id BIGSERIAL PRIMARY KEY,
    batch_id UUID NOT NULL,
    run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
    question_key TEXT,                                   -- NULL for batch-level summary rows
    metric TEXT NOT NULL,
    value NUMERIC,
    threshold NUMERIC,
    passed BOOLEAN,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- INDEXES
-- =============================================================================
-- ivfflat builds its lists from the rows present at build time; `make ingest`
-- REINDEXes this after loading embeddings.
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
