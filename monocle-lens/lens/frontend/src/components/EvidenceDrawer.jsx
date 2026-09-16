import { useEffect, useRef, useState } from 'react'
import { getChunkContext } from '../api'
import { sectionTail } from './MetaStrip'

const CONTEXT_CHARS = 1200

/** The cited quote, highlighted in its section context. */
export default function EvidenceDrawer({ citation, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const closeRef = useRef(null)
  const markRef = useRef(null)

  useEffect(() => {
    if (!citation) return
    setData(null)
    setError(null)
    getChunkContext(citation.chunk_id)
      .then((res) => setData(res.data))
      .catch(() => setError('The source text could not be loaded. Close this and try the citation again.'))
  }, [citation])

  // Escape closes, and focus moves into the drawer so a keyboard user is not
  // left behind on the answer.
  useEffect(() => {
    if (!citation) return undefined
    closeRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [citation, onClose])

  // Scroll the highlight into view once the surrounding context has rendered.
  useEffect(() => {
    if (!data) return
    markRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [data])

  if (!citation) return null

  let before = ''
  let quote = citation.quote
  let after = ''
  if (data) {
    const { text, char_start: base } = data.context
    const from = (citation.char_start ?? 0) - base
    const to = (citation.char_end ?? 0) - base
    if (from >= 0 && to > from && to <= text.length) {
      before = text.slice(Math.max(0, from - CONTEXT_CHARS), from)
      quote = text.slice(from, to)
      after = text.slice(to, to + CONTEXT_CHARS)
    } else {
      before = text.slice(0, CONTEXT_CHARS)
      after = ''
    }
  }

  return (
    <>
      <div
        className="veil fixed inset-0 z-20 bg-navy-deep/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Source text — ${citation.short_name}`}
        className="drawer fixed inset-y-0 right-0 z-30 flex w-full max-w-[580px] flex-col border-l border-line bg-paper shadow-rail"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <p className="eyebrow">{citation.short_name}</p>
            <h2 className="mt-1.5 text-section font-medium leading-6">
              {sectionTail(citation.section_path)}
            </h2>
            {data && (
              <p className="mt-1.5 text-meta tabular text-slate2">
                {data.chunk.page_no ? `Page ${data.chunk.page_no}` : ''}
                {/* A passage opened from the knowledge network carries no quote, and so
                    no character range — the whole section is shown instead. */}
                {citation.char_start != null &&
                  `${data.chunk.page_no ? ', ' : ''}characters ${citation.char_start}–${citation.char_end}`}
              </p>
            )}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="btn-quiet shrink-0">
            Close
          </button>
        </header>

        <div className="flex-1 overflow-auto px-6 py-6">
          {error && <p className="notice-error">{error}</p>}
          {!data && !error && <p className="text-body text-slate2">Loading the source text…</p>}
          {data && (
            <p className="whitespace-pre-wrap font-serif text-quote leading-[25px]">
              <span className="text-slate2">{before}</span>
              <mark ref={markRef} className="cite">{quote}</mark>
              <span className="text-slate2">{after}</span>
            </p>
          )}
        </div>

        {data && (
          <footer className="border-t border-line bg-paper-soft px-6 py-4 text-meta text-slate2">
            <p className="truncate">{data.chunk.doc_title}</p>
            <p className="mt-1 font-mono text-slate2-light">
              sha256 {String(data.chunk.sha256 || '').slice(0, 16)}…
            </p>
          </footer>
        )}
      </aside>
    </>
  )
}
