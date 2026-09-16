# Build Plan — "Lens": a regulatory RAG agent with full traceability

**Hand this file to Claude Code as the specification.** It is written to be executed, not discussed. Where it says MUST, treat it as an acceptance criterion.

**Author / owner:** Tevin Richard
**Purpose:** a working demonstration, built ahead of an interview for the AI Practice Lead role at Monocle, showing (a) a production-shaped agentic RAG application over financial-services regulation, and (b) complete observability — every retrieval, tool call, prompt and generation auditable after the fact.

**It must start with one command:** `docker compose up --build -d`.

---

## 0. The brief in one paragraph

Build a containerised web application in which a user asks a question about financial-services and AI regulation. An agent running on **Azure OpenAI (AI Foundry)** plans its approach, calls tools (corpus search, section fetch, framework comparison, EU AI Act risk tiering), synthesises a cited answer, and refuses to answer when the corpus does not support one. Every run is traced to span level and stored in **PostgreSQL**. A second area of the app lists conversation history and lets you drill into any single turn to replay exactly what the agent did: which chunks were retrieved and at what score, which were actually used, what arguments went to each tool and what came back, the exact prompt sent to the model, token counts, latency, cost, and the guardrail verdicts. The interface uses the Monocle colour and type system.

**The audit trail is the product.** Answer quality is table stakes; the traceability is what gets discussed in the room. Build it as a first-class feature from phase one, not as logging bolted on at the end.

---

## 1. Non-negotiables

1. **One command up.** `docker compose up --build -d` brings up database, backend and frontend, applies migrations, and serves a working application. No manual steps between clone and demo other than populating `.env` and running the ingest command.
2. **Ask → cited answer**, with every claim traceable to a document, section and quoted span of text.
3. **Abstention** — when the corpus cannot support an answer, the agent says so and does not improvise. Demonstrable on command.
4. **Audit** — from conversation history, drill into any turn and reconstruct the entire execution: spans, tools, chunks, prompts, scores, timings, costs.

If time runs short, cut the evaluation harness (§12) and the `compare_frameworks` tool before cutting any of the above.

---

## 2. Stack

Chosen for reliability in a live demo over novelty. Do not substitute without reason.

| Layer | Choice | Notes |
|---|---|---|
| Orchestration | **Docker Compose** — three services: `db`, `backend`, `frontend` | Single `docker compose up --build -d` |
| Database | **PostgreSQL 16** with **pgvector** (`pgvector/pgvector:pg16`) | Relational data, traces **and** vectors in one store |
| DB driver | **pyodbc** over the PostgreSQL ODBC driver (psqlODBC) | Installed in the backend image; see §3.2 and the note in §4 |
| Data access | Raw SQL through a thin repository layer — **no ORM** | Queries stay readable; the audit queries are worth showing |
| Backend | Python 3.11, FastAPI + Uvicorn | |
| LLM | Azure OpenAI (AI Foundry) via `openai` SDK `AzureOpenAI` client | Chat + embedding deployments, names from env |
| Embeddings | Azure OpenAI `text-embedding-3-large` deployment | 3072 dims, stored in `pgvector` |
| PDF parsing | **PyMuPDF (`pymupdf`)** | Section-aware extraction with page and offset tracking |
| HTML parsing | `selectolax` (or `trafilatura` if cleaner for a given source) | |
| Keyword search | PostgreSQL full-text (`tsvector` + `websearch_to_tsquery`) | Hybrid partner to pgvector |
| Frontend | React 18 + Vite + TypeScript + Tailwind, served by nginx | Tailwind theme extended with the Monocle tokens in §13 |
| Tracing | Custom span model (§10) written to PostgreSQL, plus optional OTLP export behind a flag | |

**Agent orchestration:** write the loop by hand — a small, readable `agent/loop.py`. Do not pull in LangChain or LangGraph. The point of this application is that every step is visible and explainable; a framework hides exactly the thing being demonstrated. State this in the README as a deliberate trade for auditability, not as a view that frameworks are wrong.

---

## 3. Containers and one-command startup

### 3.1 `compose.yaml` (root)

Three services. The backend waits for a healthy database; the frontend waits for the backend.

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro   # 00_extensions.sql -> CREATE EXTENSION vector;
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 20
    ports: ["5432:5432"]          # exposed so you can open a SQL client in the room

  backend:
    build: ./backend
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
    volumes:
      - ./corpus:/app/corpus       # source documents persist outside the container
    ports: ["8000:8000"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:8000/api/health')"]
      interval: 10s
      timeout: 5s
      retries: 10

  frontend:
    build:
      context: ./frontend
      args:
        VITE_API_BASE: /api
    depends_on:
      backend: { condition: service_started }
    ports: ["3000:80"]             # nginx serves the build and proxies /api -> backend:8000

volumes:
  pgdata:
```

The application is then at **http://localhost:3000**.

### 3.2 `backend/Dockerfile`

Must install the ODBC runtime and the PostgreSQL ODBC driver, because `pyodbc` needs a driver to talk to:

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      unixodbc unixodbc-dev odbc-postgresql gcc g++ \
    && rm -rf /var/lib/apt/lists/*
# odbc-postgresql registers "PostgreSQL Unicode" in /etc/odbcinst.ini

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

The backend MUST verify the driver at startup (`pyodbc.drivers()`) and fail with a clear message naming the expected driver if it is absent. On startup it also applies any unapplied files in `db/sql/` in filename order, recording them in a `schema_migrations` table.

### 3.3 `frontend/Dockerfile`

Multi-stage: `node:20-alpine` build → `nginx:alpine` serving `/usr/share/nginx/html`, with an `nginx.conf` that proxies `/api/` to `http://backend:8000/` and falls back to `index.html` for client-side routing.

### 3.4 Makefile convenience (wrappers only — compose remains the source of truth)

```
make up       -> docker compose up --build -d
make logs     -> docker compose logs -f backend
make ingest   -> docker compose exec backend python -m backend.ingest.cli --all
make eval     -> docker compose exec backend python -m backend.evals.run
make seed     -> docker compose exec backend python -m backend.demo.seed
make down     -> docker compose down          (add -v to drop the database)
make psql     -> docker compose exec db psql -U $$POSTGRES_USER -d $$POSTGRES_DB
```

---

## 4. A note to keep in the README (you will be asked about it)

`pyodbc` against PostgreSQL is a deliberate choice, not an accident: it is the data-access path in use in my current environment across SQL Server and PostgreSQL, and keeping one driver interface means one connection-pooling, one error-handling and one credential pattern rather than two. The trade is that `pgvector`'s `vector` type is not native to ODBC, so vector parameters are bound as text and cast in SQL (`CAST(? AS vector)`) — explicit, and visible in every query. If the driver ever becomes the bottleneck, the repository layer is the only thing that would change; nothing above it knows what the driver is. **Write this into the README and be ready to say it out loud — an architect on the panel will notice the choice and respect a considered answer far more than a default one.**

---

## 5. Repo layout

```
lens/
  README.md
  compose.yaml
  Makefile
  .env.example
  db/
    init/00_extensions.sql        # CREATE EXTENSION IF NOT EXISTS vector;
    sql/001_core.sql              # documents, chunks
    sql/002_tracing.sql           # conversations, runs, spans, tool_calls, ...
    sql/003_indexes.sql           # ivfflat, GIN tsvector, FK indexes
  backend/
    Dockerfile
    requirements.txt
    backend/
      main.py                     # FastAPI app, health, migration runner
      config.py                   # env, deployment names, feature flags
      db/
        conn.py                   # pyodbc connection + pool, driver check
        repo.py                   # typed repository functions, raw SQL
        migrate.py
      ingest/
        fetch.py                  # download from corpus.yaml, sha256
        parse_pdf.py              # PyMuPDF: text, page, char offsets, headings
        parse_html.py
        chunk.py                  # section-aware chunking
        embed.py                  # Azure embeddings, batched, retry
        cli.py
      retrieval/
        hybrid.py                 # pgvector + tsvector, RRF in SQL
      agent/
        loop.py
        tools.py
        prompts/                  # versioned prompt files, hashed at load
        guardrails.py
      tracing/
        tracer.py
        otlp.py                   # optional exporter (flag)
      api/
        chat.py                   # POST /api/chat (SSE)
        audit.py                  # conversations, runs, trace, export
        corpus.py
        evals.py
      demo/
        seed.py                   # seeded conversations for demo mode
      evals/
        run.py
  frontend/
    Dockerfile
    nginx.conf
    src/
      theme.ts
      components/
      pages/{Ask,Audit,AuditDetail,Corpus,Evals}.tsx
  corpus/
    corpus.yaml
    raw/                          # gitignored, bind-mounted
  evals/questions.yaml
```

---

## 6. Configuration

Single `.env` at the repo root, consumed by compose and the backend. The app MUST fail loudly and specifically when a variable is missing.

```
# database
POSTGRES_DB=lens
POSTGRES_USER=lens
POSTGRES_PASSWORD=change_me
PGHOST=db
PGPORT=5432
ODBC_DRIVER=PostgreSQL Unicode

# azure openai (ai foundry)
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large

# app
LENS_DEMO_MODE=false
LENS_OTLP_ENDPOINT=
LENS_COST_PER_1K_INPUT=0.0
LENS_COST_PER_1K_OUTPUT=0.0
LENS_CONFIDENCE_THRESHOLD=0.55
```

Connection string built in `conn.py`:
`DRIVER={{{ODBC_DRIVER}}};SERVER={PGHOST};PORT={PGPORT};DATABASE={POSTGRES_DB};UID={POSTGRES_USER};PWD={POSTGRES_PASSWORD};`

---

## 7. Corpus

`corpus/corpus.yaml` lists public regulatory sources with URL, publisher, version and a licence note. `make ingest` downloads them into `corpus/raw/`, records SHA-256 of each file, and writes provenance into `documents`. **Do not commit the source documents** — ingest fetches them.

| Key | Document | Why it earns its place |
|---|---|---|
| `ss123` | PRA SS1/23 — Model risk management principles for banks | Named in the job spec (PS 7/23 introduced it) |
| `sr117` | SR 11-7 — Supervisory guidance on model risk management (US Fed) | Named in the spec; the comparison to SS1/23 is the money demo |
| `euaiact` | Regulation (EU) 2024/1689 — the EU AI Act | Named in the spec; risk tiering drives a non-retrieval tool |
| `popia` | Protection of Personal Information Act (South Africa) | Local relevance; the "can we send client data to an LLM" question |
| `iso42001` | ISO/IEC 42001 public overview material | AI management system framing |
| `bcbs239` | BCBS 239 — Risk data aggregation principles | Data lineage, which FS consultants meet constantly |

**PDF handling with PyMuPDF.** For each page, extract text blocks with their bounding boxes, use font size and weight to infer heading levels, and build a hierarchical `section_path` (e.g. `SS1/23 > Principle 2 > 2.4`). Retain `page_no` and `char_start`/`char_end` offsets into the normalised document text — the citation highlighting in the audit view depends on them. Chunk at ~800 tokens with 120 overlap, never crossing a top-level section boundary.

---

## 8. Retrieval

Hybrid, executed in PostgreSQL, and visible in the trace:

1. **Dense** — `ORDER BY embedding <=> CAST(? AS vector) LIMIT 20` over `chunks`, ivfflat index (`lists = 100`), cosine.
2. **Keyword** — `websearch_to_tsquery` against a `tsvector` column with a GIN index, `ts_rank_cd`, limit 20.
3. **Fusion** — reciprocal rank fusion (`k = 60`) combining both, top 8 returned.
4. Optional filter by `doc_id` when the agent passes one.

Every retrieval call MUST persist, per candidate: `chunk_id`, `doc_id`, `section_path`, `rank`, `score`, `retriever` (`dense` | `keyword` | `fused`), and later `used_in_answer`. The audit view shows retrieved-but-unused chunks muted — being able to say *"here is what it considered and discarded"* is a strong moment in the room.

---

## 9. The agent

A deliberate loop, max 3 tool iterations, every stage a span:

```
receive question
  → guardrail: input PII scan, log verdict
  → plan (LLM, structured output: {intent, frameworks[], tool_calls[]})
  → execute tools (parallel where independent)
  → if evidence insufficient and iterations remain: refine query, loop
  → synthesise (LLM with retrieved context, structured output: {answer, citations[], confidence, unsupported_claims[]})
  → guardrail: groundedness — every citation must resolve to a real chunk; unsupported claims stripped
  → if confidence < LENS_CONFIDENCE_THRESHOLD or zero citations: ABSTAIN, explaining what was searched
  → return answer + citations + run_id
```

### Tool contracts

OpenAI tool calling with strict JSON schemas. Implement exactly these five:

**`search_corpus(query, frameworks|null, top_k=8)`** — hybrid retrieval; returns chunk id, document, section path, score, text.

**`fetch_section(doc_id, section_path)`** — full text of a section, for when a chunk truncates an obligation. Shows the agent going to get more rather than guessing.

**`compare_frameworks(topic, frameworks[])`** — per-framework retrieval, returned aligned and grouped.

**`classify_ai_act_risk(system_description, sector, uses_biometrics, affects_credit_or_employment)`** — a **deterministic, non-LLM** decision table returning `{tier, rationale, obligations[], article_refs[]}`. Include this specifically: it proves the agent calls real logic, not only search, and its output is exactly reproducible in the audit view.

**`list_obligations(framework, role)`** — structured obligations for a role (`second_line`, `model_owner`, `provider`, `deployer`), each cited.

Tool arguments and results MUST be persisted verbatim as `jsonb` against the span.

### Prompts

`agent/prompts/*.md`, loaded at startup, hashed (SHA-256, first 8 chars), recorded in `prompt_versions`. Every run records the version it used. This is the detail a model-risk person will notice: **you can prove which prompt produced which answer.**

---

## 10. Observability — the centrepiece

One `run` per user turn; spans form a tree. Span types: `agent`, `llm`, `retrieval`, `tool`, `guardrail`.

```sql
-- 001_core.sql
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text UNIQUE NOT NULL,
  title         text NOT NULL,
  publisher     text,
  source_url    text,
  version       text,
  retrieved_at  timestamptz,
  sha256        text,
  licence_note  text,
  status        text NOT NULL DEFAULT 'ok'      -- ok | unavailable
);

CREATE TABLE chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_path  text NOT NULL,
  page_no       int,
  char_start    int,
  char_end      int,
  text          text NOT NULL,
  tokens        int,
  embedding     vector(3072),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

-- 002_tracing.sql
CREATE TABLE prompt_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, hash text NOT NULL, content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (name, hash));

CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text, created_at timestamptz NOT NULL DEFAULT now(), model_deployment text);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message text NOT NULL, final_answer text,
  status text NOT NULL,                      -- ok | abstained | error
  abstain_reason text, confidence numeric,
  prompt_version_id uuid REFERENCES prompt_versions(id),
  model_deployment text,
  started_at timestamptz NOT NULL, ended_at timestamptz, latency_ms int,
  input_tokens int, output_tokens int, cost_usd numeric(10,6),
  trace_id text NOT NULL
);

CREATE TABLE spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_span_id uuid REFERENCES spans(id) ON DELETE CASCADE,
  name text NOT NULL, type text NOT NULL, sequence int NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz, duration_ms int,
  status text NOT NULL, error text,
  input_json jsonb, output_json jsonb, attributes_json jsonb
);

CREATE TABLE tool_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  span_id uuid NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  tool_name text NOT NULL, arguments_json jsonb, result_json jsonb,
  ok boolean NOT NULL, error text, duration_ms int);

CREATE TABLE retrieved_chunks (id bigserial PRIMARY KEY,
  span_id uuid NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES chunks(id),
  rank int, score numeric, retriever text, used_in_answer boolean DEFAULT false);

CREATE TABLE citations (id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES chunks(id),
  doc_id uuid NOT NULL REFERENCES documents(id),
  section_path text, quote text, char_start int, char_end int);

CREATE TABLE guardrail_events (id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  span_id uuid REFERENCES spans(id) ON DELETE CASCADE,
  kind text NOT NULL, verdict text NOT NULL, detail_json jsonb);

CREATE TABLE evals (id bigserial PRIMARY KEY,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  metric text NOT NULL, value numeric, notes text,
  created_at timestamptz NOT NULL DEFAULT now());
```

`tracer.py` exposes a context manager so instrumenting a step is one line:

```python
with tracer.span("retrieval.hybrid", type="retrieval", parent=ctx,
                 attributes={"query": q, "top_k": k}) as span:
    results = hybrid_search(q, k)
    span.set_output({"n": len(results), "top_score": float(results[0].score)})
```

Rules: no step reaches the model or the database without a span; spans persist **even on error**; LLM spans always record `model_deployment`, `prompt_version`, `temperature`, `max_tokens`. Behind `LENS_OTLP_ENDPOINT`, emit the same spans in OpenTelemetry GenAI conventions — an hour's work that answers "would this plug into what we already run?".

---

## 11. The application UI

Four routes, left rail navigation, Monocle styling (§13).

### `/` — Ask
Question input; answer streamed over SSE. Inline citation chips `[SS1/23 §2.4]` open a right-hand drawer with the quoted text highlighted in section context. Beneath every answer, a thin metadata strip: latency, tokens, cost, model deployment, prompt version, tools called, confidence — always visible. A persistent **"View full trace →"** link. Abstentions render in a calm, distinct style (not red) listing what was searched.

### `/audit` — Conversation history
Table, newest first: `time · question · status chip (ok / abstained / error) · tools used · chunks retrieved · latency · tokens · cost`. Filters by status, date, tool, framework cited; search over question text. Row click → detail.

### `/audit/:runId` — Trace detail — **the screen they will remember**

1. **Header** — question, answer, status, confidence, model deployment, prompt version hash, latency, tokens, cost, trace id. Buttons: **Export audit pack (JSON)**, **Replay this run**.
2. **Timeline** — horizontal span waterfall, proportional widths, colour-coded by type, hover for duration and status, click to expand.
3. **Span detail** —
   - `llm`: the exact rendered prompt (system, tools, messages) with the version hash, raw response, finish reason, token split.
   - `tool`: arguments and results JSON, pretty-printed, duration, ok/error.
   - `retrieval`: every candidate — rank, score, retriever, document, section path, preview, used-in-answer flag; unused rows muted.
   - `guardrail`: verdict, redaction types and counts (never values), groundedness result, stripped claims.
4. **Evidence** — citations as they appear in the answer, expandable to the full source section with the cited span highlighted.

**Replay** re-runs the question against the current prompt version and diffs answer, citations and cost side by side — change control, demonstrated without a test suite.

### `/corpus` — What the agent can see
Documents with publisher, version, retrieval date, SHA-256, chunk count, status. Honest framing: *"the agent knows these six documents and nothing else."*

### `/evals` — Last eval run (§12), each row linking to its trace.

---

## 12. Evaluation harness

`evals/questions.yaml` — 20–25 questions with expected source documents, and `must_cite` sections for a subset. `make eval` runs them and writes to `evals`:

- **Citation precision** — do citations resolve and support the sentence (LLM-judged, strict rubric, separate cheap deployment).
- **Groundedness** — proportion of answer sentences with supporting evidence.
- **Retrieval hit rate @8.**
- **Abstention correctness** — on 5 deliberately unanswerable questions.
- **Latency p50/p95, cost per question.**

Thresholds live in the file so the run reports pass/fail, not a number needing interpretation.

---

## 13. Design system — Monocle

Clean, restrained, mostly white with navy structural blocks.

> **Superseded by the real brand.** The palette and type below were written from memory
> before the live values were to hand, and several are wrong. The authority is now
> `lens/frontend/tailwind.config.js`, whose values were read off monoclesolutions.com:
> red `#E82B2B` (not `#E4002C`), navy `#112232`, teal `#75C9D6`, tealDark `#268599`,
> greys `#5C5C5C` / `#898989` / `#EDEDED`. The face is **Montserrat**, not Poppins, with
> Share Tech Mono for machine text — both are what the Monocle site itself serves. The
> corporate mark is checked in at `lens/frontend/public/brand/logo.svg`. Keep the rest of
> this section's *intent* (restraint, hairlines, text-not-icon status, navy blocks); take
> the values from the config.

```ts
// Historical — see the note above.
export const colors = {
  navy:      '#14263A',
  navyDeep:  '#0E1B2B',
  teal:      '#84CED9',   // accent on dark
  tealDark:  '#268599',   // accent on light
  red:       '#E4002C',   // sparing: labels, active state, alerts
  slate:     '#5E6E7B',
  slateLight:'#8B9AA6',
  paper:     '#FFFFFF',
  paperTint: '#F1F5F7',
  line:      '#DCE4E9',
}
```

- **Type:** Poppins (300/400/500/600) throughout; 300 for body, 500 for labels and headings. Eyebrows 10–11px uppercase, letter-spacing `0.2em`, tealDark on light / teal on dark.
- **Scale:** page title 30/500 · section heading 18/500 · body 13/300 · table 12 · meta 11.
- **Layout:** 24px gutters, 16px between cards, hairline dividers rather than boxes. Left nav 220px, navy, active item marked by a 2px teal left rule, never a filled block.
- **Tables:** no vertical rules, 1px `line` horizontals, 10px cell padding, numerics right-aligned with tabular figures.
- **Status chips:** `ok` tealDark on paperTint · `abstained` slate on paperTint · `error` red on `#FDEEF1`. Text, not icons.
- **Waterfall colours:** `agent` navy · `llm` tealDark · `retrieval` `#7FA8B8` · `tool` red at 70% · `guardrail` slate.
- **JSON blocks:** monospace 11.5px on paperTint with a hairline border, collapsible above 20 lines.
- **Header:** wordmark **"Lens"** in Poppins 500 with a thin red slash before it as a nod to the Monocle mark, and a small muted strap on every page: **"Prototype · built by Tevin Richard"**. It must be obvious to any viewer that this is a personal prototype styled in the Monocle palette, not a Monocle product.

---

## 14. Demo mode

`LENS_DEMO_MODE=true` serves recorded responses keyed by normalised question hash, with realistic streaming delays, against a seeded database. `make seed` inserts 8 prior conversations — including one abstention and one deliberate tool error — so the audit tab is populated the moment it opens. Build this in phase 3, not at the end. It is the insurance policy against a conference-room network.

---

## 15. Using it in the interview

Open on `/audit` — populated history — rather than an empty chat box. It reads as a system that has been running, not a toy just started.

**Five questions, in this order:**

1. **"What does SS1/23 require for independent model validation, and how does that compare with SR 11-7?"** → `compare_frameworks`; multi-tool planning and cross-corpus synthesis.
2. **"A bank wants an LLM to draft credit decline letters sent to customers. Under the EU AI Act, what risk tier is that and what obligations follow?"** → `classify_ai_act_risk` *and* `search_corpus`. Afterwards, point at the trace: *"the tier came from a decision table, not the model — reproducible, and here is the code path."*
3. **"What evidence would a second line typically expect before approving a GenAI use case that touches customer data?"** → the question that sounds like the job.
4. **"Under POPIA, what applies when client personal information is sent to a third-party LLM provider?"** → local relevance; the corpus is not only European.
5. **"What is Monocle's internal AI acceptable use policy?"** → **abstains.** Say nothing while it does. Then: *"it has six documents and it knows it. That refusal is the feature — in a regulated environment I would rather ship something that declines than something that improvises."*

Then open `/audit`, select question 2, and walk the waterfall: plan → two tool spans → retrieval candidates with scores, three used and five discarded → the exact prompt with its version hash → the groundedness check → tokens and cost. Finish on **Export audit pack**:

> *"If a validator asks in nine months why this answer was given, this JSON is the answer. Prompt version, retrieved evidence, tool arguments, model deployment, timestamps."*

Keep one more thing ready: edit a prompt file, hit **Replay**, show the diff.

If anyone asks how it is deployed, the honest answer is the strongest one: *"three containers, one command — here."* Then run `docker compose up --build -d` on a clean checkout.

---

## 16. Build phases

Each phase ends with something demonstrable. Do not start the next until acceptance passes.

**Phase 0 — Compose skeleton (½ day)**
`compose.yaml`, both Dockerfiles, `.env.example`, pgvector extension, migration runner, `pyodbc` connectivity, `/api/health`, styled React shell with nav and empty routes.
*Accept:* on a clean clone, `docker compose up --build -d` gives a healthy stack; http://localhost:3000 shows the shell; `/api/health` reports database connected and names the ODBC driver in use.

**Phase 1 — Corpus and retrieval (1 day)**
`corpus.yaml`, fetch with SHA-256, PyMuPDF parsing with section paths, chunking, embeddings, pgvector + tsvector, hybrid RRF, `/corpus`.
*Accept:* `make ingest` builds from scratch inside the container; a CLI query returns ranked chunks with correct section paths; `/corpus` lists six documents with hashes and chunk counts.

**Phase 2 — Agent and tools (1½ days)**
Loop, five tools, structured outputs, streamed cited answers, guardrails, abstention.
*Accept:* all five demo questions in §15 behave as described, including the abstention.

**Phase 3 — Tracing and audit UI (1½ days) — the priority**
Tracer, full span persistence, `/audit`, `/audit/:runId` with waterfall, span detail, evidence panel, export pack, replay. Demo mode and seed data.
*Accept:* each demo question produces a complete trace; a fresh stack in demo mode shows populated history with no Azure connectivity.

**Phase 4 — Evaluation (½ day)**
Eval set, metrics, `make eval`, `/evals` linking to traces.
*Accept:* `make eval` prints a pass/fail table and persists results.

**Phase 5 — Polish (½ day)**
Empty and loading states, keyboard submit, errors that surface the failed span rather than a stack trace, README with architecture diagram, the pyodbc note from §4, and the design decisions (no framework, hybrid retrieval, deterministic risk tiering).
*Accept:* clean laptop, `docker compose up --build -d`, working demo in under five minutes.

---

## 17. Rules for the build

- **Never fabricate corpus content.** A failed download shows as `unavailable` in `/corpus`; the app does not quietly continue with five documents.
- **No secrets in the repo**, no keys in logs, no personal data in the eval set.
- **Every LLM call gets a timeout and one retry with backoff**; failures create an error span and a visible error state.
- **The trace is written even when the run fails.** Failure traces are good demo material.
- **Parameterised SQL only** — no string interpolation into queries, including the vector cast.
- Keep prompt files short and readable. Someone will ask to see one.
- Write the README as though a Monocle engineer will read it, because one might.

---

## 18. Working with Claude Code

One phase at a time. Suggested prompts:

1. *"Read BUILD_PLAN.md. Implement Phase 0 exactly as specified. Get `docker compose up --build -d` green before writing any UI beyond the shell."*
2. *"Phase 1. Start with `corpus.yaml` and the PyMuPDF parser; show me the parsed section tree for SS1/23 before chunking."*
3. *"Phase 2. Write `tools.py` first with the JSON schemas, then the loop. Keep the loop under 150 lines and readable."*
4. *"Phase 3. Tracer first, then persistence, then UI. Show me a full trace JSON for one run before building the waterfall."*
5. *"Phase 4, then Phase 5."*

After each phase, have it run the five demo questions and paste the trace summary, so regressions surface immediately. If you have a front-end or design skill configured, invoke it for `/audit/:runId` — that screen carries the demo and deserves the extra pass.

---

## Appendix — what this proves against the job specification

| Specification line | Where it shows up |
|---|---|
| Hands-on building and deploying AI systems, not prototypes | A containerised application with guardrails, migrations, health checks and demo-mode resilience |
| RAG, tool calling, structured outputs, evaluation, observability | §8, §9, §10, §12 — all five, demonstrably |
| Enterprise AI integration and agentic systems | Hand-written agent loop with deterministic tools alongside retrieval |
| Enterprise system integration in complex environments | Compose topology, ODBC data access, migration discipline |
| AI governance — PS 7/23, EU AI Act, SR 11-7 | The corpus itself, and the audit pack as a validation artefact |
| Reusable assets validated before being positioned externally | This is one — a governance-grade RAG pattern that could become an accelerator |
| Client-ready outputs for senior stakeholders | The audit pack, and the application you walk them through |