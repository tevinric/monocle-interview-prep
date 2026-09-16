"""
Corpus ingest.

    python -m lens.ingest.cli --all [--offline] [--no-embed] [--force]
    python -m lens.ingest.cli --doc euaiact --show-sections
    python -m lens.ingest.cli --query "independent model validation"

Re-ingest is safe. A document whose SHA-256 has not changed is skipped; when it has
changed, the previous sections and chunks are deactivated rather than deleted, so every
past trace still resolves to the exact text it cited.
"""
import argparse
import sys
import uuid

from psycopg2.extras import execute_values

from app import _ensure_schema
from lens.config import get_settings
from lens.corpus import RAW_DIR, load_manifest, manifest_by_key
from lens.db import db_cursor
from lens.ingest import embed as embedder
from lens.ingest.chunk import chunk_document
from lens.ingest.fetch import fetch
from lens.ingest.parse_html import parse_html
from lens.ingest.parse_pdf import parse_pdf


def _parse(path, doc):
    return parse_html(path, doc) if path.endswith('.html') else parse_pdf(path, doc)


def _upsert_document(cur, doc):
    cur.execute(
        """
        INSERT INTO documents (key, short_name, title, publisher, source_url, version, licence_note)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (key) DO UPDATE
           SET short_name = EXCLUDED.short_name, title = EXCLUDED.title, publisher = EXCLUDED.publisher,
               source_url = EXCLUDED.source_url, version = EXCLUDED.version, licence_note = EXCLUDED.licence_note
        RETURNING id, sha256, status
        """,
        (doc['key'], doc.get('short_name'), doc['title'], doc.get('publisher'), doc.get('source_url'),
         doc.get('version'), doc.get('licence_note')),
    )
    return cur.fetchone()


def _store(doc_uuid, sha256, batch, parsed, chunks):
    with db_cursor(commit=True) as cur:
        section_ids = []
        for section in parsed['sections']:
            cur.execute(
                """
                INSERT INTO sections (doc_id, document_sha256, ingest_batch, section_path, heading, level, ordinal,
                                      page_start, page_end, char_start, char_end, text, active)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE)
                RETURNING id
                """,
                (doc_uuid, sha256, batch, section['section_path'], section['heading'], section['level'],
                 section['ordinal'], section['page_start'], section['page_end'], section['char_start'],
                 section['char_end'], section['text']),
            )
            section_ids.append(str(cur.fetchone()['id']))
        execute_values(
            cur,
            """
            INSERT INTO chunks (doc_id, section_id, document_sha256, ingest_batch, section_path, ordinal, page_no,
                                char_start, char_end, text, tokens, active)
            VALUES %s
            """,
            [(doc_uuid, section_ids[c['section_index']], sha256, batch, c['section_path'], c['ordinal'], c['page_no'],
              c['char_start'], c['char_end'], c['text'], c['tokens'], False) for c in chunks],
        )


def _activate(doc_uuid, batch):
    """Retire every earlier batch for this document. Nothing is deleted: past traces must
    still resolve to the exact text they cited."""
    # COALESCE, because rows ingested before ingest_batch existed have NULL there, and
    # `NULL = batch` is NULL — which would violate the NOT NULL on active.
    with db_cursor(commit=True) as cur:
        cur.execute('UPDATE sections SET active = COALESCE(ingest_batch = %s, FALSE) WHERE doc_id = %s',
                    (batch, doc_uuid))
        cur.execute('UPDATE chunks SET active = COALESCE(ingest_batch = %s, FALSE) WHERE doc_id = %s',
                    (batch, doc_uuid))


def ingest_document(doc, settings, offline=False, no_embed=False, force=False):
    print(f"\n── {doc['key']}: {doc['title']}")
    with db_cursor(commit=True) as cur:
        row = _upsert_document(cur, doc)
    doc_uuid, previous_sha = str(row['id']), row['sha256']

    result = fetch(doc, RAW_DIR, offline=offline)
    if result.status != 'ok':
        print(f'   UNAVAILABLE — {result.detail}')
        with db_cursor(commit=True) as cur:
            cur.execute("UPDATE documents SET status = 'unavailable', status_detail = %s WHERE id = %s",
                        (result.detail, doc_uuid))
        return 'unavailable'
    print(f'   fetched {result.bytes:,} bytes  sha256 {result.sha256[:12]}…')

    if previous_sha == result.sha256 and not force:
        with db_cursor() as cur:
            cur.execute("""SELECT count(*) AS n, count(embedding) AS embedded FROM chunks
                            WHERE doc_id = %s AND active""", (doc_uuid,))
            counts = cur.fetchone()
        if counts['n'] and (counts['embedded'] == counts['n'] or no_embed):
            print(f"   unchanged — {counts['n']} chunks already ingested")
            with db_cursor(commit=True) as cur:
                cur.execute("UPDATE documents SET status = 'ok', status_detail = 'unchanged' WHERE id = %s", (doc_uuid,))
            return 'unchanged'

    parsed = _parse(result.path, doc)
    chunks = chunk_document(parsed)
    print(f"   parsed {parsed['page_count']} pages → {len(parsed['sections'])} sections → {len(chunks)} chunks")
    batch = str(uuid.uuid4())
    _store(doc_uuid, result.sha256, batch, parsed, chunks)

    embedded = 0
    if not no_embed:
        embedded = embedder.embed_document(
            doc_uuid, batch, settings,
            progress=lambda done, total: print(f'   embedding {done}/{total}', end='\r', flush=True))
        print(f'   embedded {embedded} chunks                    ')
    _activate(doc_uuid, batch)

    status = 'ok' if (no_embed or embedded or not chunks) else 'ok'
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE documents SET sha256 = %s, bytes = %s, content_type = %s, retrieved_at = %s, page_count = %s,
                                 embedding_model = %s, status = %s, status_detail = %s
             WHERE id = %s
            """,
            (result.sha256, result.bytes, result.content_type, result.retrieved_at, parsed['page_count'],
             None if no_embed else settings.embedding_model, status, result.detail, doc_uuid),
        )
    return 'ingested'


def show_sections(doc):
    result = fetch(doc, RAW_DIR, offline=True)
    if result.status != 'ok':
        result = fetch(doc, RAW_DIR)
    if result.status != 'ok':
        sys.exit(f'cannot read {doc["key"]}: {result.detail}')
    parsed = _parse(result.path, doc)
    for section in parsed['sections']:
        size = section['char_end'] - section['char_start']
        print(f"{'  ' * (section['level'] - 1)}{section['section_path']}  "
              f"(p.{section['page_start']}–{section['page_end']}, {size:,} chars)")
    print(f"\n{len(parsed['sections'])} sections, {parsed['page_count']} pages, {len(parsed['text']):,} characters")


def run_query(text, settings):
    from lens.llm import LLMClient
    from lens.retrieval.hybrid import hybrid_search
    vector = LLMClient(settings).embed([text])[0]
    results = hybrid_search(text, vector, None, 8)
    print(f'\nfused top {len(results["fused"])} (dense {len(results["dense"])}, keyword {len(results["keyword"])}):')
    for c in results['fused']:
        print(f"  {c['rank']:>2}. {c['score']:.4f}  {c['short_name']:<14} {c['section_path'][:70]}")
        print(f"      {' '.join(c['text'].split())[:150]}…")


def main():
    parser = argparse.ArgumentParser(description='Ingest the Lens corpus')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--doc', action='append', default=[])
    parser.add_argument('--offline', action='store_true', help='use the copies already in corpus/raw')
    parser.add_argument('--no-embed', action='store_true', help='parse and store without calling Azure OpenAI')
    parser.add_argument('--force', action='store_true', help='re-parse even if the SHA-256 is unchanged')
    parser.add_argument('--show-sections', action='store_true', help='print the parsed section tree and stop')
    parser.add_argument('--query', help='run one hybrid search and print the ranked chunks')
    args = parser.parse_args()

    settings = get_settings()
    _ensure_schema()

    if args.query:
        return run_query(args.query, settings)

    manifest = manifest_by_key()
    keys = [d['key'] for d in load_manifest()] if args.all or not args.doc else args.doc
    unknown = [k for k in keys if k not in manifest]
    if unknown:
        sys.exit(f'unknown document keys: {unknown}')

    if args.show_sections:
        for key in keys:
            show_sections(manifest[key])
        return

    outcomes = {}
    for key in keys:
        try:
            outcomes[key] = ingest_document(manifest[key], settings, args.offline, args.no_embed, args.force)
        except Exception as e:
            outcomes[key] = f'error: {e.__class__.__name__}: {e}'
            print(f'   ERROR — {outcomes[key]}')
            with db_cursor(commit=True) as cur:
                cur.execute("UPDATE documents SET status = 'unavailable', status_detail = %s WHERE key = %s",
                            (outcomes[key], key))

    with db_cursor(commit=True) as cur:
        cur.execute('REINDEX INDEX idx_chunks_embedding')     # ivfflat lists are built from the data present
        cur.execute('ANALYZE chunks')

    print('\nSummary')
    for key, outcome in outcomes.items():
        print(f'  {key:<10} {outcome}')
    with db_cursor() as cur:
        cur.execute("""SELECT d.key, count(c.id) AS chunks, count(c.embedding) AS embedded
                         FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id AND c.active
                        GROUP BY d.key ORDER BY d.key""")
        for row in cur.fetchall():
            print(f"  {row['key']:<10} {row['chunks']:>5} chunks, {row['embedded']:>5} embedded")
    if any(o != 'ingested' and o != 'unchanged' for o in outcomes.values()):
        sys.exit(2)


if __name__ == '__main__':
    main()
