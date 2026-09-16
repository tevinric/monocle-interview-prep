"""
Hybrid retrieval, executed in PostgreSQL as ONE statement — readable in the trace and
runnable by hand in a SQL client:

  dense    cosine distance over vector(1536) embeddings (ivfflat, lists = 100), top 20
  keyword  full-text over the generated tsvector column (GIN), ts_rank_cd, top 20
  fused    reciprocal rank fusion, k = 60, top_k returned

Every candidate from all three lists comes back with its retriever label, so the audit
view can show what was considered and discarded, not only what was used. Ties are broken
by (document key, chunk ordinal) — stable across re-ingests, which keeps demo recordings
replayable.
"""
from lens.db import get_db_connection, vector_literal

RRF_K = 60
DENSE_LIMIT = 20
KEYWORD_LIMIT = 20
IVFFLAT_PROBES = 10

HYBRID_SQL = """
WITH q AS (
    -- websearch_to_tsquery ANDs every term, so a natural-language query would match
    -- almost nothing. Relax it to any-term (OR) and let ts_rank_cd do the ordering.
    SELECT to_tsquery('english',
             replace(websearch_to_tsquery('english', %(query)s)::text, ' & ', ' | ')) AS tsq
),
dense AS (
    SELECT id, row_number() OVER (ORDER BY distance, doc_key, ordinal) AS rank, 1 - distance AS score
    FROM (
        SELECT c.id, d.key AS doc_key, c.ordinal,
               c.embedding <=> CAST(%(qvec)s AS vector(1536)) AS distance
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        WHERE c.active AND c.embedding IS NOT NULL
          AND (%(doc_keys)s::text[] IS NULL OR d.key = ANY(%(doc_keys)s::text[]))
        ORDER BY c.embedding <=> CAST(%(qvec)s AS vector(1536))
        LIMIT %(dense_limit)s
    ) nearest
),
keyword AS (
    SELECT id, row_number() OVER (ORDER BY rank_cd DESC, doc_key, ordinal) AS rank, rank_cd AS score
    FROM (
        SELECT c.id, d.key AS doc_key, c.ordinal, ts_rank_cd(c.tsv, q.tsq) AS rank_cd
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        CROSS JOIN q
        WHERE c.active AND c.tsv @@ q.tsq
          AND (%(doc_keys)s::text[] IS NULL OR d.key = ANY(%(doc_keys)s::text[]))
        ORDER BY rank_cd DESC, d.key, c.ordinal
        LIMIT %(keyword_limit)s
    ) matched
),
fused AS (
    SELECT COALESCE(dense.id, keyword.id) AS id,
           COALESCE(1.0 / (%(rrf_k)s + dense.rank), 0)
         + COALESCE(1.0 / (%(rrf_k)s + keyword.rank), 0) AS score,
           dense.rank AS dense_rank,
           keyword.rank AS keyword_rank
    FROM dense
    FULL OUTER JOIN keyword ON keyword.id = dense.id
),
fused_ranked AS (
    SELECT f.id, row_number() OVER (ORDER BY f.score DESC, d.key, c.ordinal) AS rank,
           f.score, f.dense_rank, f.keyword_rank
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.doc_id
    ORDER BY rank
    LIMIT %(top_k)s
),
candidates AS (
    SELECT 'fused' AS retriever, id, rank, score::float8 AS score, dense_rank, keyword_rank FROM fused_ranked
    UNION ALL
    SELECT 'dense', id, rank, score::float8, NULL, NULL FROM dense
    UNION ALL
    SELECT 'keyword', id, rank, score::float8, NULL, NULL FROM keyword
)
SELECT cand.retriever, cand.rank, cand.score, cand.dense_rank, cand.keyword_rank,
       c.id AS chunk_id, c.doc_id, d.key AS doc_key, d.short_name, d.title AS doc_title,
       c.section_path, c.page_no, c.char_start, c.char_end, c.ordinal, c.text
FROM candidates cand
JOIN chunks c ON c.id = cand.id
JOIN documents d ON d.id = c.doc_id
ORDER BY CASE cand.retriever WHEN 'fused' THEN 0 WHEN 'dense' THEN 1 ELSE 2 END, cand.rank
"""


def retrieval_parameters(top_k):
    return {'rrf_k': RRF_K, 'dense_limit': DENSE_LIMIT, 'keyword_limit': KEYWORD_LIMIT,
            'ivfflat_probes': IVFFLAT_PROBES, 'top_k': top_k,
            'keyword_mode': 'websearch_to_tsquery, any-term'}


def hybrid_search(query, query_embedding, doc_keys=None, top_k=8):
    """Returns {'fused': [...], 'dense': [...], 'keyword': [...]} — every candidate."""
    params = {
        'query': query,
        'qvec': vector_literal(query_embedding),
        'doc_keys': list(doc_keys) if doc_keys else None,
        'dense_limit': DENSE_LIMIT,
        'keyword_limit': KEYWORD_LIMIT,
        'rrf_k': RRF_K,
        'top_k': top_k,
    }
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(f'SET LOCAL ivfflat.probes = {IVFFLAT_PROBES}')
        cur.execute(HYBRID_SQL, params)
        rows = cur.fetchall()
        cur.close()
        conn.rollback()     # read-only; ends the transaction that scoped SET LOCAL
    finally:
        conn.close()

    results = {'fused': [], 'dense': [], 'keyword': []}
    for r in rows:
        results[r['retriever']].append({
            'retriever': r['retriever'],
            'rank': int(r['rank']),
            'score': round(float(r['score']), 6),
            'dense_rank': r['dense_rank'],
            'keyword_rank': r['keyword_rank'],
            'chunk_id': str(r['chunk_id']),
            'doc_id': str(r['doc_id']),
            'doc_key': r['doc_key'],
            'short_name': r['short_name'],
            'doc_title': r['doc_title'],
            'section_path': r['section_path'],
            'page_no': r['page_no'],
            'char_start': r['char_start'],
            'char_end': r['char_end'],
            'ordinal': r['ordinal'],
            'text': r['text'],
        })
    return results
