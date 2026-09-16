import { fmtMs } from './MetaStrip'

// Exported so the Help page explains the timeline using the same colours it draws.
export const SPAN_COLOURS = {
  agent: '#112232',
  llm: '#268599',
  retrieval: '#7FA8B8',
  tool: 'rgba(232, 43, 43, 0.72)',
  guardrail: '#5C5C5C',
}

const FAILED_COLOUR = '#E82B2B'

const COLOURS = SPAN_COLOURS

const TICKS = [0, 0.25, 0.5, 0.75, 1]

export function spanDepth(spans) {
  const byId = Object.fromEntries(spans.map((s) => [s.id, s]))
  const depth = {}
  spans.forEach((span) => {
    let d = 0
    let cursor = span
    while (cursor?.parent_span_id && byId[cursor.parent_span_id] && d < 8) {
      d += 1
      cursor = byId[cursor.parent_span_id]
    }
    depth[span.id] = d
  })
  return depth
}

/** The vertical rules the bars are read against. Inset to sit exactly under the
 *  track column, so a bar's left edge lines up with a labelled time. */
function Gridlines() {
  return (
    <div
      className="pointer-events-none absolute inset-y-0"
      style={{ left: 'calc(var(--wf-name) + 12px)', right: 'calc(var(--wf-dur) + 12px)' }}
      aria-hidden="true"
    >
      {TICKS.map((t) => (
        <span
          key={t}
          className={`absolute top-0 h-full w-px ${t === 0 || t === 1 ? 'bg-line-strong' : 'bg-line'}`}
          style={{ left: `${t * 100}%`, transform: t === 1 ? 'translateX(-1px)' : undefined }}
        />
      ))}
    </div>
  )
}

export default function Waterfall({ run, spans, selected, onSelect }) {
  const start = new Date(run.started_at).getTime()
  const end = new Date(run.ended_at || run.started_at).getTime()
  const total = Math.max(end - start, 1)
  const depth = spanDepth(spans)
  const kinds = [...new Set(spans.map((s) => s.type))].filter((k) => COLOURS[k])

  return (
    <div className="[--wf-dur:64px] [--wf-name:136px] sm:[--wf-name:220px] lg:[--wf-name:280px]">
      {/* Which colour means what. Shown only for the span types this run used. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pb-3 text-meta text-slate2">
        {kinds.map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              className="h-[3px] w-4 rounded-[1px]"
              style={{ background: COLOURS[kind] }}
              aria-hidden="true"
            />
            {kind}
          </span>
        ))}
      </div>

      {/* Time axis. The run starts at zero and ends at its measured duration. */}
      <div className="flex items-end gap-3 border-b border-line-strong pb-1">
        <span className="w-[var(--wf-name)] shrink-0 text-meta text-slate2-light">Step</span>
        <span className="relative h-4 flex-1">
          {TICKS.map((t) => (
            <span
              key={t}
              // The quarter marks collide once the track narrows; the gridlines
              // stay, so the scale is still readable without their labels.
              className={`absolute bottom-0 whitespace-nowrap text-meta tabular text-slate2-light ${
                t === 0.25 || t === 0.75 ? 'hidden sm:inline' : ''
              }`}
              style={{
                left: `${t * 100}%`,
                transform: t === 0 ? 'none' : t === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {t === 0 ? '0' : fmtMs(Math.round(total * t))}
            </span>
          ))}
        </span>
        <span className="w-[var(--wf-dur)] shrink-0 text-right text-meta text-slate2-light">Took</span>
      </div>

      <div className="relative pt-1">
        <Gridlines />
        <ul className="relative space-y-[2px]">
          {spans.map((span, i) => {
            const spanStart = new Date(span.started_at).getTime()
            const left = Math.min(Math.max(((spanStart - start) / total) * 100, 0), 99.5)
            const width = Math.min(Math.max(((span.duration_ms || 0) / total) * 100, 0.4), 100 - left)
            const isSelected = selected === span.id
            const failed = span.status === 'error'
            return (
              <li key={span.id}>
                <button
                  type="button"
                  onClick={() => onSelect(span.id)}
                  aria-pressed={isSelected}
                  title={`${span.name} · ${fmtMs(span.duration_ms)} · ${span.status}`}
                  className={`group/row flex w-full items-center gap-3 border-l-2 py-[5px] pr-2 text-left transition-colors duration-200 ease-smooth ${
                    isSelected
                      ? 'border-teal-dark bg-paper-tint'
                      : 'border-transparent hover:bg-paper-tint'
                  }`}
                >
                  <span
                    className="flex w-[var(--wf-name)] shrink-0 items-center gap-1.5 truncate pl-2 text-table"
                    style={{ paddingLeft: 8 + depth[span.id] * 12 }}
                  >
                    {failed && (
                      <span
                        className="h-[9px] w-[3px] shrink-0 -skew-x-[18deg] bg-brand-red"
                        aria-hidden="true"
                      />
                    )}
                    <span className={`truncate ${isSelected ? 'font-medium' : 'font-light'}`}>
                      {span.name}
                    </span>
                  </span>

                  <span className="relative h-[9px] flex-1">
                    <span
                      className={`bar-draw absolute top-0 h-[9px] rounded-[1px] transition-[filter,box-shadow] duration-200 ease-smooth ${
                        isSelected ? 'shadow-[0_0_0_2px_rgba(38,133,153,0.25)]' : ''
                      } group-hover/row:brightness-110`}
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        minWidth: '2px',
                        background: failed ? FAILED_COLOUR : COLOURS[span.type] || '#898989',
                        '--i': i,
                      }}
                    />
                  </span>

                  <span className="num w-[var(--wf-dur)] shrink-0 text-meta text-slate2">
                    {fmtMs(span.duration_ms)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
