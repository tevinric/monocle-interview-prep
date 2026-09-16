import { useMemo, useState } from 'react'
import { CHUNK_R, DOC_R, VIEW, collectKnowledge, layoutKnowledge } from './flow/knowledge'

const HALF = VIEW / 2

const QUOTED = '#22788A'
const CONSIDERED = '#B8C6CE'

/**
 * A document's link to one of its passages, bowed outward along the ring.
 *
 * A straight line would be a chord, and a document holding a wide sector — a run that
 * reached only one framework — would have its own links cutting across the answer in
 * the middle. Curving them through the annulus keeps the centre clear.
 */
function linkPath(doc, chunk) {
  const angle = (doc.angle + chunk.angle) / 2
  const radius = ((DOC_R + chunk.r) / 2) * 1.06
  return `M ${doc.x} ${doc.y} Q ${Math.cos(angle) * radius} ${Math.sin(angle) * radius} ${chunk.x} ${chunk.y}`
}

function docPillWidth(doc) {
  return Math.max(70, String(doc.shortName || doc.key).length * 7.4 + 26)
}

/**
 * The corpus as this run saw it: every passage the retrievers ranked, grouped under its
 * document, with the ones that were quoted marked and everything else left visible but
 * quiet. What was rejected is part of the record, so it is drawn rather than filtered.
 */
export default function KnowledgeMap({ run, spans, citations, onOpenChunk, height = 440 }) {
  const knowledge = useMemo(() => collectKnowledge(spans, citations), [spans, citations])
  const [onlyQuoted, setOnlyQuoted] = useState(false)
  const [focusDoc, setFocusDoc] = useState(null)
  const [active, setActive] = useState(null)

  const documents = useMemo(
    () => layoutKnowledge(knowledge, onlyQuoted),
    [knowledge, onlyQuoted],
  )

  if (knowledge.total === 0) {
    return (
      <p className="rounded-lg border border-line bg-paper-soft px-5 py-8 text-center text-body text-slate2">
        This run retrieved nothing from the corpus, so there is no knowledge network to draw.
      </p>
    )
  }

  const centreLabel =
    run.status === 'ok' ? 'Answer' : run.status === 'abstained' ? 'Abstained' : 'Failed'
  const dim = (key) => focusDoc && focusDoc !== key

  const open = (chunk) => {
    setActive(chunk)
    onOpenChunk(chunk)
  }

  return (
    <div className="rounded-lg border border-line bg-paper-soft">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-meta text-slate2">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: QUOTED }} aria-hidden="true" />
            quoted in the answer — {knowledge.quoted}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: CONSIDERED }} aria-hidden="true" />
            considered, not used — {knowledge.total - knowledge.quoted}
          </span>
          <span>{knowledge.documents.length} documents reached</span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-meta text-slate2">
          <input
            type="checkbox"
            checked={onlyQuoted}
            onChange={(e) => setOnlyQuoted(e.target.checked)}
            className="h-3.5 w-3.5 accent-teal-dark"
          />
          Only what was quoted
        </label>
      </div>

      <div className="relative">
        <svg
          viewBox={`${-HALF} ${-HALF} ${VIEW} ${VIEW}`}
          style={{ height }}
          className="w-full"
          role="group"
          aria-label="Knowledge network: documents and passages this run retrieved."
        >
          {/* The rings the two layers sit on, so distance reads as a step away from the answer. */}
          {[DOC_R, CHUNK_R].map((r) => (
            <circle key={r} cx="0" cy="0" r={r} fill="none" stroke="#E6EBEF" strokeDasharray="3 6" />
          ))}

          {documents.map((doc) => (
            <g key={doc.key} opacity={dim(doc.key) ? 0.22 : 1}>
              <line
                x1="0"
                y1="0"
                x2={doc.x}
                y2={doc.y}
                stroke={doc.quoted ? QUOTED : CONSIDERED}
                strokeWidth={doc.quoted ? 1.4 : 0.9}
                opacity={doc.quoted ? 0.75 : 0.5}
              />
              {doc.nodes.map((chunk) => (
                <path
                  key={chunk.id}
                  d={linkPath(doc, chunk)}
                  fill="none"
                  stroke={chunk.citation ? QUOTED : CONSIDERED}
                  strokeWidth={chunk.citation ? 1.3 : 0.8}
                  opacity={chunk.citation ? 0.8 : 0.45}
                />
              ))}
            </g>
          ))}

          {documents.map((doc) => (
            <g key={doc.key} opacity={dim(doc.key) ? 0.28 : 1}>
              {doc.nodes.map((chunk) => {
                const label = chunk.citation?.marker
                return (
                  <g
                    key={chunk.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${chunk.shortName} ${chunk.sectionRef}. ${
                      chunk.citation ? 'Quoted in the answer.' : 'Considered, not used.'
                    } Select to read the passage.`}
                    className="cursor-pointer outline-none"
                    onMouseEnter={() => setActive(chunk)}
                    onFocus={() => setActive(chunk)}
                    onClick={() => open(chunk)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        open(chunk)
                      }
                    }}
                  >
                    <circle
                      cx={chunk.x}
                      cy={chunk.y}
                      r={chunk.radius + 8}
                      fill="transparent"
                    />
                    <circle
                      cx={chunk.x}
                      cy={chunk.y}
                      r={chunk.radius}
                      fill={chunk.citation ? QUOTED : '#FFFFFF'}
                      stroke={chunk.citation ? QUOTED : CONSIDERED}
                      strokeWidth={active?.id === chunk.id ? 2.4 : 1.2}
                      className="transition-[r,stroke-width] duration-200"
                    />
                    {label && (
                      <text
                        x={chunk.x}
                        y={chunk.y + 3}
                        textAnchor="middle"
                        fontSize="8.5"
                        fontWeight="600"
                        fill="#FFFFFF"
                      >
                        {label}
                      </text>
                    )}
                    {/* The section reference follows the pointer rather than standing on
                        every quoted passage: a dozen labels around one arc collide, and
                        the panel below already names what is under the cursor. */}
                    {active?.id === chunk.id && (
                      <text
                        x={chunk.x + Math.cos(chunk.angle) * (chunk.radius + 7)}
                        y={chunk.y + Math.sin(chunk.angle) * (chunk.radius + 7) + 3}
                        textAnchor={Math.cos(chunk.angle) < 0 ? 'end' : 'start'}
                        fontSize="9.5"
                        fill="#5C5C5C"
                      >
                        {chunk.sectionRef}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          ))}

          {documents.map((doc) => {
            const w = docPillWidth(doc)
            return (
              <g
                key={doc.key}
                role="button"
                tabIndex={0}
                aria-label={`${doc.shortName}: ${doc.chunks.length} passages retrieved, ${doc.quoted} quoted. Select to isolate.`}
                className="cursor-pointer outline-none"
                opacity={dim(doc.key) ? 0.35 : 1}
                onClick={() => setFocusDoc(focusDoc === doc.key ? null : doc.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setFocusDoc(focusDoc === doc.key ? null : doc.key)
                  }
                }}
              >
                <rect
                  x={doc.x - w / 2}
                  y={doc.y - 17}
                  width={w}
                  height={34}
                  rx="8"
                  fill="#FFFFFF"
                  stroke={focusDoc === doc.key ? QUOTED : '#C9D3DA'}
                  strokeWidth={focusDoc === doc.key ? 1.8 : 1}
                />
                <text x={doc.x} y={doc.y - 2} textAnchor="middle" fontSize="11" fontWeight="600" fill="#112232">
                  {doc.shortName}
                </text>
                <text x={doc.x} y={doc.y + 10} textAnchor="middle" fontSize="9.5" fill="#767676">
                  {doc.quoted} of {doc.chunks.length} used
                </text>
              </g>
            )
          })}

          <g>
            <circle cx="0" cy="0" r="46" fill="#112232" />
            <text x="0" y="-4" textAnchor="middle" fontSize="12" fontWeight="600" fill="#FFFFFF">
              {centreLabel}
            </text>
            <text x="0" y="11" textAnchor="middle" fontSize="9.5" fill="#9AA6AE">
              {knowledge.quoted} quoted
            </text>
          </g>
        </svg>

        {/* What the pointer is over, printed rather than floated — a tooltip this size
            would cover the passages it is describing. */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3">
          {active ? (
            <div className="item-in max-w-[520px] rounded-md border border-line bg-paper/95 px-3.5 py-2.5 shadow-card backdrop-blur-sm">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="eyebrow">{active.shortName}</span>
                <span className="text-meta text-slate2">{active.sectionTail || active.sectionRef}</span>
                <span className="text-meta tabular text-slate2-light">
                  {active.score == null ? 'exact lookup' : `score ${active.score.toFixed(4)}`}
                  {active.retrieverList?.length ? ` · ${active.retrieverList.join(', ')}` : ''}
                </span>
              </p>
              <p className="mt-1.5 line-clamp-2 font-serif text-[12.5px] leading-[18px] text-navy">
                {active.preview}
              </p>
              <p className="mt-1.5 text-[10.5px] text-slate2-light">
                {active.citation
                  ? `Quoted as ${active.citation.marker}. Select to read it in context.`
                  : 'Retrieved but not quoted. Select to read it in context.'}
              </p>
            </div>
          ) : (
            <p className="text-meta text-slate2-light">
              Hover a passage to see what it says. Select a document to isolate it.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
