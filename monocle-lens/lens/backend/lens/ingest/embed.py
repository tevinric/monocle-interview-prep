"""Embed chunks in batches with Azure OpenAI, and write the vectors into pgvector."""
from lens.db import db_cursor, vector_literal
from lens.llm import LLMClient

BATCH_SIZE = 32


def embed_document(doc_uuid, batch, settings, progress=lambda done, total: None):
    client = LLMClient(settings)
    with db_cursor() as cur:
        cur.execute(
            """SELECT id, text FROM chunks
                WHERE doc_id = %s AND ingest_batch = %s AND embedding IS NULL ORDER BY ordinal""",
            (doc_uuid, batch))
        pending = cur.fetchall()

    total = len(pending)
    for offset in range(0, total, BATCH_SIZE):
        batch = pending[offset:offset + BATCH_SIZE]
        vectors = client.embed([row['text'] for row in batch])
        with db_cursor(commit=True) as cur:
            for row, vector in zip(batch, vectors):
                cur.execute(
                    'UPDATE chunks SET embedding = CAST(%s AS vector(1536)), embedding_model = %s WHERE id = %s',
                    (vector_literal(vector), settings.embedding_model, row['id']))
        progress(min(offset + BATCH_SIZE, total), total)
    return total
