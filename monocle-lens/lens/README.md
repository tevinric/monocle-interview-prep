# Lens

A regulatory RAG agent whose **audit trail is the product**. Ask a question about
financial-services and AI regulation; an agent on the OpenAI API plans its approach, calls
tools, retrieves evidence from six public regulatory documents, and answers with citations
you can click through to the source text — or refuses, when the corpus cannot support an
answer. Every retrieval, tool call, prompt, model response, guardrail verdict, token and
cent is stored in PostgreSQL and can be replayed afterwards.

Prototype, built by Tevin Richard. Styled in the Monocle palette; not a Monocle product.

```bash
source ./lens_kv_init.sh          # four service-principal variables for the vault
docker compose up --build -d      # or: make up
make check-model                  # proves the models answer before you spend anything
make ingest                       # downloads the corpus, parses, chunks, embeds
```

Then open **http://localhost:3100**. The API is on 5100, PostgreSQL on 5439.

---

## Architecture

```
  browser ── nginx :3100 ──/api──▶ Flask + gunicorn :5000 ──▶ PostgreSQL 16 + pgvector
                                          │                     documents, sections, chunks
                                          │                     runs, spans, tool_calls,
                                          │                     retrieved_chunks, citations,
                                          │                     guardrail_events, evals
                                          └──▶ OpenAI API
                                               chat + embedding models

  keyvault-init ──▶ Azure Key Vault ──▶ lens_secrets volume ──▶ postgres, backend
  (runs first, exits 0)                  four LENS-* credentials
```

Four containers, one command. `keyvault-init` fetches the credentials and exits; postgres
and the backend refuse to start until it has succeeded.

### Models

| Role | Default | Price per 1M | Why |
|---|---|---|---|
| Agent | `gpt-5.6-luna` | $0.20 in / $1.20 out | Cheapest current model with tool calling and structured outputs |
| Judge (evaluation only) | `gpt-5-nano` | $0.05 / $0.40 | A *different* model grades the answers, so the system never marks its own work |
| Embeddings | `text-embedding-3-small` | $0.02 | 1536 dimensions — inside pgvector's 2,000-dim index limit |

Model families differ in what the API accepts, and the backend adapts rather than
guessing: reasoning models (`gpt-5*`, `gpt-6*`, `o*`) get `max_completion_tokens` and
`reasoning_effort` and no `temperature`; older models (`gpt-4o`, `gpt-4.1`) get
`max_tokens` and `temperature`. Whatever was sent is recorded on the span. Swap models in
`.env` and run `make check-model` to confirm the new one works before ingesting.

`LENS_REASONING_EFFORT` accepts `none`, `low`, `medium`, `high` or `xhigh`; `minimal` and
`max` were withdrawn from the API and are rejected at startup. On a reasoning model
`LENS_LLM_MAX_TOKENS` is a budget for reasoning **and** the answer, which is why it
defaults to 8000 there and 2000 on a standard model — too low and replies are cut off
with `finish_reason=length`.

`gpt-6-astra` is deliberately **not** the default: it requires the Responses API, while
Lens is built on Chat Completions.

### How one turn works

```
question
  → guardrail: PII scan (redacted before it is stored or sent to the model)
  → plan            LLM, structured output {intent, frameworks, tool_calls}
  → tools           executed in parallel, each its own span
  → repeat while the planner says the evidence is insufficient (max 3 iterations)
  → synthesise      LLM, structured output {answer, citations, confidence, unsupported_claims}
  → guardrail: groundedness — every citation must resolve to evidence gathered in this run
               and its quote must appear verbatim; unverified sentences are stripped
  → answer, or abstain and say exactly what was searched
```

The answer is released only **after** the groundedness check, then streamed to the browser.
Nothing ungrounded is ever shown and then retracted.

---

## What makes it auditable

| Guarantee | How |
|---|---|
| Every step is recorded | A span row is written when a step **starts** and updated when it ends, so a crash leaves the step in the trace rather than erasing it. If the trace cannot be written, the step does not run. |
| Only assigned accounts get in | With `LENS-ENV-TYPE=PROD` every route but the healthcheck needs an Entra access token, re-validated server-side on each request — signature against the tenant's live signing keys, then issuer, audience, tenant, expiry, scope and allow-list. The browser holds a token; it does not hold the decision. |
| Answers are traceable to text | Citations store the chunk, section path and character offsets of the quote, so the audit view highlights the exact words in their section. |
| Rejected evidence is visible | Every candidate from every retriever is stored with its rank, score and `used_in_answer` flag — you can show what the agent considered and discarded. |
| Prompts are versioned | Prompt files are hashed (SHA-256, first 8 chars) and recorded in `prompt_versions`; each run stores the bundle it used, each LLM span the individual prompt. |
| Configuration is versioned | Each run stores a snapshot of its effective non-secret configuration and a hash of it — model, sampling parameters, thresholds, prices. |
| Reasoning is accounted for | Thinking tokens are billed as output; the span records `reasoning_tokens` separately so cost is explainable. |
| Totals cannot drift | A run's tokens and cost are computed by summing its own LLM spans, not tracked separately. |
| Sources are pinned | Documents carry SHA-256, retrieval date and licence. Re-ingesting deactivates the previous chunks instead of deleting them, so past traces still resolve to the text they cited. |
| A trace can be read three ways | The same spans as a **flow map** (what the agent did, and what fed what — each pass of the loop on its own band), a **knowledge network** (what it reached in the corpus, and which passages survived into the answer) and the **timeline** (where the time went). All three select the same span, so the detail panel is driven identically from any of them. |
| It exports | **Export audit pack** produces a single JSON: run, spans, tool arguments and results, every retrieved candidate, evidence text, prompts in full, document provenance, plus a SHA-256 of the pack itself. |
| It replays | **Replay this run** re-runs the question against the current prompt version and diffs answer, citations and cost side by side. Change control, without a test suite. |

Optional: set `LENS_OTLP_ENDPOINT` and the same spans are exported in OpenTelemetry GenAI
conventions (`gen_ai.*`). PostgreSQL stays the system of record.

---

## Design decisions

**No agent framework.** The loop is ~150 readable lines in `backend/lens/agent/loop.py`.
LangChain or LangGraph would hide exactly the thing this application exists to demonstrate.
That is a trade for auditability, not a view that frameworks are wrong.

**Hybrid retrieval in one SQL statement.** Dense (pgvector, cosine, ivfflat) and keyword
(`tsvector`, `ts_rank_cd`) are fused with reciprocal rank fusion (k=60) in a single query in
`backend/lens/retrieval/hybrid.py` — readable in the trace and runnable by hand in psql.
`websearch_to_tsquery` is relaxed to any-term, since a natural-language question ANDed
across every term matches almost nothing.

**Deterministic risk tiering.** `classify_ai_act_risk` is a decision table, not a model:
same inputs, same tier, same article references, and the table's hash travels with every
result. It then resolves each article reference to the Act's own text, so the answer cites
the regulation rather than the tool. It is conservative: where Article 6(3) offers a
derogation that needs a documented human assessment, it reports it and does not apply it.

**Vectors are bound as text and cast in SQL** (`CAST(%s AS vector(1536))`) — explicit, and
visible in every query. Changing the embedding model means changing that dimension in
`database/sql_init.sql` *and* the `_SCHEMA_SQL` block in `app.py`, then re-ingesting.

**Data access: psycopg2, raw SQL, no ORM.** CLAUDE.md asked for pyodbc over psqlODBC; the
house backend convention in `claude_skills/backend-conventions` standardises on psycopg2,
and that convention won. The trade is the same either way: the repository layer is the only
thing that knows the driver, and the audit queries stay readable SQL worth showing.

**Single-turn by design.** Conversation history is grouped but never fed back to the model.
Each answer stands on its own evidence, which is what makes it auditable in isolation.

**The brand is the real one, taken from source.** CLAUDE.md §13 specified a Monocle palette
from memory, and it was close but wrong: the corporate red is `#E82B2B` rather than
`#E4002C`, the face is **Montserrat** rather than Poppins, and the teals are `#75C9D6` /
`#268599`. The values in `frontend/tailwind.config.js` were read off monoclesolutions.com
and supersede the spec. The mark in `frontend/public/brand/logo.svg` is Monocle's own,
with its letterforms set to `currentColor` so one file serves the navy rail and light
surfaces alike; the diagonal in it is reused across the interface as a section marker.

The lockup reads **Monocle │ Lens**, and the strap under it says *Prototype · built by
Tevin Richard* on every screen. That is deliberate: this is a personal prototype styled in
the Monocle brand, and nothing about it should read as a Monocle product.

---

## Secrets and configuration

Credentials live in **Azure Key Vault** and are fetched at startup by `keyvault-init`.
Nothing but four service-principal variables exists in the shell, and no credential appears
in `docker inspect` on a long-lived service.

| Key Vault secret | Maps to | What it is |
|---|---|---|
| `LENS-DB-NAME` | `LENS_DB_NAME` | PostgreSQL database name |
| `LENS-DB-USER` | `LENS_DB_USER` | PostgreSQL role |
| `LENS-DB-PASSWORD` | `LENS_DB_PASSWORD` | PostgreSQL password |
| `LENS-OPENAI-API-KEY` | `LENS_OPENAI_API_KEY` | OpenAI API key (`sk-…`) |

All four are required: a missing one stops the whole stack with an explicit error rather
than starting on defaults.

Sign-in is configured in the same place. None of these is a credential — a tenant id, a
client id and a scope name are all visible in the address bar during a sign-in, and the
SPA flow uses no client secret — but they are what differs between a laptop and a
deployment, and the switch that turns authentication **on** should not be something a
shell variable on the host can turn off.

| Key Vault secret | Default | What it is |
|---|---|---|
| `LENS-ENV-TYPE` | `DEV` | `PROD` requires a valid Entra access token on every API call; `DEV` bypasses sign-in |
| `LENS-ENTRA-TENANT-ID` | — | Directory (tenant) ID. Required when `PROD` |
| `LENS-ENTRA-SPA-CLIENT-ID` | — | Application (client) ID of the Lens registration. Required when `PROD` |
| `LENS-ENTRA-API-CLIENT-ID` | the SPA's | Only if the API is a separate registration |
| `LENS-ENTRA-API-SCOPE` | `Lens.Access` | The delegated scope the token must carry |
| `LENS-ENTRA-ALLOWED-UPNS` | — | Optional second gate, on top of Entra's own assignment list |
| `LENS-ENTRA-ALLOWED-GROUPS` | — | Optional, by group object id (needs the groups claim) |

In `PROD` the backend refuses to start without the tenant and client ids: a container that
came up half-configured would serve the whole API unauthenticated. In `DEV` the bypass is
loud rather than silent — a warning at startup, `"auth": "bypassed"` from `/api/health`,
and `env_type` written into every run's configuration snapshot, so a trace recorded on an
unauthenticated stack still says so months later.

**[docs/ENTRA_SETUP.md](docs/ENTRA_SETUP.md)** is the step-by-step: the app registration,
the SPA platform, the exposed scope, who may sign in, the vault entries, and
`make check-auth` — which fetches your tenant's signing keys and then requires the
validator to reject a set of deliberately wrong tokens.

Everything else is **not secret** and is committed in `docker-compose.yml` — the base URL,
model names, sampling parameters, the confidence threshold and the token prices — so a
change shows up in git history. Every run also stores the effective values, so an override
on one machine is still visible in the trace. Point `LENS_OPENAI_BASE_URL` at a
compatible gateway if you route through one. See [SETUP.md](SETUP.md) for vault creation
and the security posture.

---

## The corpus

Six public documents, fetched by `make ingest` and never committed:

| Key | Document | Why it earns its place |
|---|---|---|
| `ss123` | PRA SS1/23 — Model risk management principles for banks | UK model risk expectations |
| `sr117` | SR 11-7 — Supervisory guidance on model risk management | The comparison with SS1/23 |
| `euaiact` | Regulation (EU) 2024/1689 — the EU AI Act | Risk tiering and obligations |
| `popia` | Protection of Personal Information Act (South Africa) | "Can we send client data to an LLM?" |
| `iso42001` | Public overview material on ISO/IEC 42001 | AI management system framing |
| `bcbs239` | BCBS 239 — Risk data aggregation principles | Data lineage |

Documents are parsed with PyMuPDF into a section tree (`SS1/23 > Principle 4 – Independent
model validation`) with page numbers and character offsets, then chunked at ~800 tokens
with 120 overlap, never crossing a top-level section.

**Honest caveat:** the ISO/IEC 42001 standard itself is sold by ISO and is not in the
corpus. What is ingested is a public overview written by Microsoft and hosted by UNIDO, and
answers citing it reflect that summary rather than the standard. A source that fails to
download is marked `unavailable` in `/corpus`; the agent is told it cannot search it.

---

## Demo mode

`LENS_DEMO_MODE=true` replays recorded model responses instead of calling OpenAI.
Retrieval, tools, guardrails and tracing still run for real against the database — only the
model calls come from `backend/lens/demo/recordings/`, captured from real API calls by
`make record`. Spans say so (`llm_source: recording`), and a replay whose request no longer
matches the recording is marked on the span rather than hidden.

`make seed` populates the audit history with eight turns, including one abstention and one
deliberate tool failure, so `/audit` opens on a system that has been running.

`make up-offline` starts without network access to OpenAI, reusing the credentials already
on the `lens_secrets` volume from the last online start.

---

## Evaluation

`make eval` runs 25 questions from `evals/questions.yaml` — 20 answerable, 5 deliberately
not — and writes every metric to the `evals` table with the threshold it was judged
against, so the output is pass/fail rather than a number needing interpretation:

citation precision · groundedness · retrieval hit rate @8 · abstention correctness ·
latency p50/p95 · cost per question.

Citation precision and groundedness are judged by `gpt-5-nano`, a different model from the
one under test. The judge's own calls are traced in their own run, so the cost of
evaluating never contaminates the runs being evaluated. Every eval row links to its trace
at `/evals`.

---

## Repo layout

```
lens/
  docker-compose.yml  Makefile  .env.example  lens_kv_init.sh.example
  database/sql_init.sql        full schema (mirrored in app.py's _SCHEMA_SQL)
  keyvault/                    init container: fetch_secrets.py, Dockerfile
  corpus/corpus.yaml           the six sources; raw/ is gitignored
  evals/questions.yaml         evaluation set and thresholds
  backend/
    app.py                     Flask routes + the idempotent schema block
    lens/
      config.py db.py llm.py corpus.py audit.py selftest.py
      agent/     loop.py tools.py ai_act.py guardrails.py evidence.py runs.py prompts/
      retrieval/ hybrid.py
      tracing/   tracer.py otlp.py
      ingest/    fetch.py parse_pdf.py parse_html.py chunk.py embed.py cli.py
      demo/      seed.py record.py questions.yaml recordings/
      evals/     run.py
  frontend/src/  pages/{Ask,Audit,AuditDetail,Corpus,Evals}.jsx  components/  api.js
```

## Make targets

| Command | What it does |
|---|---|
| `make up` | `docker compose up --build -d` (needs the four `LENS_AZURE_*` variables) |
| `make up-offline` | Start without OpenAI, reusing the existing secrets volume |
| `make check-model` | Call the configured chat, judge and embedding models and report what worked |
| `make ingest` | Download, parse, chunk and embed the corpus |
| `make record` | Capture live model responses for demo mode |
| `make check-auth` | Prove the Entra setup and that the validator rejects bad tokens |
| `make seed` | Populate the audit history |
| `make eval` | Run the evaluation set and print pass/fail |
| `make logs` / `make psql` / `make down` | Tail the backend · open psql · stop the stack |

## Limitations

- Not legal advice. The EU AI Act tool is a screening aid; the answers are a demonstration.
- Retrieval quality depends on PDF structure; the parser infers headings from fonts and
  wording, and a badly structured source produces coarser section paths.
- The LLM judge in the evaluation harness is a model judging a model; treat the numbers as
  a regression signal, not ground truth.
- Secrets on the Docker host are plaintext inside the `lens_secrets` volume. The design
  stops an application compromise from reaching the vault; it is not a defence against host
  compromise. See SETUP.md.
