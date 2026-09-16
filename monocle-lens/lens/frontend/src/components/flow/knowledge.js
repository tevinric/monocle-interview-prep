/**
 * The knowledge model — what the agent read, and how much of it reached the answer.
 *
 * The flow map says which steps ran. This says what they touched: every passage the
 * retrievers ranked, grouped under the document it came from, with the handful that
 * were actually quoted marked as such. The distance between "considered" and "quoted"
 * is the part of a RAG system people most often have to take on trust; here it is the
 * shape of the picture.
 *
 * Layout is radial and deterministic: documents on an inner ring, their passages on an
 * outer arc, sized by retrieval score and ordered by rank. Same trace, same drawing.
 */
import { sectionRef, sectionTail } from '../MetaStrip'

export const CENTRE_R = 52
export const DOC_R = 132
export const CHUNK_R = 242
export const VIEW = 660

const TAU = Math.PI * 2

/** One row per distinct passage, carrying its best score and whether it was quoted. */
export function collectKnowledge(spans, citations = []) {
  const quoted = new Map()
  citations.forEach((c) => quoted.set(String(c.chunk_id), c))

  const chunks = new Map()
  spans.forEach((span) => {
    const rows = span.retrieved || []
    rows.forEach((row) => {
      const id = String(row.chunk_id)
      const existing = chunks.get(id)
      const score = row.score == null ? null : Number(row.score)
      if (existing) {
        existing.retrievers.add(row.retriever)
        if (score != null && (existing.score == null || score > existing.score)) {
          existing.score = score
          existing.rank = row.rank
        }
        return
      }
      chunks.set(id, {
        id,
        chunkId: row.chunk_id,
        docKey: row.doc_key,
        shortName: row.short_name,
        sectionPath: row.section_path,
        sectionRef: sectionRef(row.section_path),
        sectionTail: sectionTail(row.section_path),
        preview: row.preview,
        pageNo: row.page_no,
        score,
        rank: row.rank,
        retrievers: new Set([row.retriever].filter(Boolean)),
        citation: quoted.get(id) || null,
      })
    })
  })

  const docs = new Map()
  chunks.forEach((chunk) => {
    if (!docs.has(chunk.docKey)) {
      docs.set(chunk.docKey, {
        key: chunk.docKey,
        shortName: chunk.shortName,
        chunks: [],
        quoted: 0,
      })
    }
    const doc = docs.get(chunk.docKey)
    doc.chunks.push(chunk)
    if (chunk.citation) doc.quoted += 1
  })

  const documents = [...docs.values()].sort(
    (a, b) => b.quoted - a.quoted || b.chunks.length - a.chunks.length ||
      String(a.shortName).localeCompare(String(b.shortName)),
  )
  documents.forEach((doc) => {
    // Best first, so the strongest evidence sits at the head of each document's arc.
    doc.chunks.sort((a, b) => Number(b.citation != null) - Number(a.citation != null) ||
      (b.score ?? -1) - (a.score ?? -1))
    doc.chunks.forEach((chunk, i) => {
      chunk.retrieverList = [...chunk.retrievers].sort()
      chunk.order = i
    })
  })

  return {
    documents,
    chunks: [...chunks.values()],
    total: chunks.size,
    quoted: [...chunks.values()].filter((c) => c.citation).length,
  }
}

/** Place the rings. `onlyQuoted` narrows each document's arc to what was cited. */
export function layoutKnowledge(knowledge, onlyQuoted = false) {
  const documents = knowledge.documents
    .map((doc) => ({ ...doc, chunks: onlyQuoted ? doc.chunks.filter((c) => c.citation) : doc.chunks }))
    .filter((doc) => doc.chunks.length > 0)

  const weights = documents.map((doc) => Math.max(1, doc.chunks.length))
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1
  // A gap between sectors, so two documents never read as one arc.
  const gap = documents.length > 1 ? Math.min(0.16, TAU / (documents.length * 7)) : 0
  const usable = TAU - gap * documents.length

  const placed = []
  let angle = -Math.PI / 2 - usable / 2 - gap / 2

  documents.forEach((doc, i) => {
    const sector = (weights[i] / totalWeight) * usable
    const start = angle + gap / 2
    const mid = start + sector / 2
    const nodes = doc.chunks.map((chunk, j) => {
      const step = sector / (doc.chunks.length + 1)
      const a = start + step * (j + 1)
      // Alternating the radius keeps a crowded document's passages from touching.
      const r = CHUNK_R + (j % 2 ? 26 : 0)
      return {
        ...chunk,
        angle: a,
        r,
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        radius: chunk.citation ? 10 : 4 + Math.min(4, (chunk.score ?? 0) * 6),
      }
    })
    placed.push({
      ...doc,
      angle: mid,
      x: Math.cos(mid) * DOC_R,
      y: Math.sin(mid) * DOC_R,
      nodes,
    })
    angle = start + sector + gap / 2
  })

  return placed
}
