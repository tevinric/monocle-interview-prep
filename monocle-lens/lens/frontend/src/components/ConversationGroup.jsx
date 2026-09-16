import { Link } from 'react-router-dom'
import StatusChip from './StatusChip'
import { fmtMs, fmtNum, fmtUsd } from './MetaStrip'

/**
 * One conversation, with its turns on a thread rail beneath it.
 *
 * A turn is no less auditable for being grouped: every figure the flat run list
 * shows is still on the row, and the row still opens the full trace. What the
 * grouping adds is the thing the flat list cannot show — that this question was
 * a follow-up to that one, and was answered in its context.
 */

const relTime = (iso) => {
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days} d ago` : then.toLocaleDateString()
}

/** The span a thread covers, written the short way when it is all one day. */
function spanOfTime(first, last) {
  const a = new Date(first)
  const b = new Date(last)
  if (a.toDateString() === b.toDateString()) {
    const day = a.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    return a.getTime() === b.getTime()
      ? `${day}, ${a.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : `${day}, ${a.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${b.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return `${a.toLocaleDateString()} – ${b.toLocaleDateString()}`
}

function Figure({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] leading-4 text-slate2-light">{label}</dt>
      <dd className="mt-[1px] whitespace-nowrap text-table font-medium tabular text-navy">{value}</dd>
    </div>
  )
}

function Turn({ turn, index, total, filtered, onOpen }) {
  const open = (e) => {
    if (e.type === 'click' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(turn.id)
    }
  }
  // A turn that did not match the filters is still shown — removing the middle of a
  // thread would misrepresent it — but muted, so the matches stay legible.
  const muted = filtered && !turn.matched

  return (
    <li className="relative">
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open the trace for turn ${index + 1}: ${turn.user_message}`}
        onClick={open}
        onKeyDown={open}
        className={`group relative cursor-pointer rounded-md py-3 pl-11 pr-3 transition-colors duration-200 ease-smooth hover:bg-paper-tint focus-visible:bg-paper-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-dark/30 ${
          muted ? 'opacity-55 hover:opacity-100 focus-visible:opacity-100' : ''
        }`}
      >
        {/* The rail: a hairline through the thread, with this turn's ordinal on it. */}
        <span
          aria-hidden="true"
          className={`absolute left-[15px] w-px bg-line ${
            index === 0 ? 'top-[26px] bottom-0' : index === total - 1 ? 'top-0 h-[26px]' : 'inset-y-0'
          }`}
        />
        <span
          aria-hidden="true"
          className={`absolute left-[7px] top-[18px] flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[10px] font-semibold tabular transition-colors duration-200 ${
            turn.matched === false && filtered
              ? 'border-line bg-paper text-slate2-light'
              : 'border-line-strong bg-paper text-slate2 group-hover:border-teal-dark group-hover:text-teal-dark'
          }`}
        >
          {index + 1}
        </span>

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <p className="max-w-measure flex-1 font-serif text-body leading-[21px] text-navy">
            {turn.user_message}
            {turn.replay_of_run_id && (
              <span className="ml-2 align-middle text-meta text-slate2-light">replay</span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <StatusChip status={turn.status} />
            <span className="whitespace-nowrap text-meta tabular text-slate2-light">
              {new Date(turn.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-slate2">
          <span>{turn.tools_used?.length ? turn.tools_used.join(', ') : 'no tools'}</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-line" />
          <span className="tabular">{turn.chunks_retrieved} chunks</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-line" />
          <span className="tabular">{turn.citation_count} citations</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-line" />
          <span className="tabular">{fmtMs(turn.latency_ms)}</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-line" />
          <span className="tabular">{fmtNum((turn.input_tokens || 0) + (turn.output_tokens || 0))} tokens</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-line" />
          <span className="tabular">{fmtUsd(turn.cost_usd)}</span>
          <span className="ml-auto text-teal-dark opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            Open trace →
          </span>
        </div>
      </div>
    </li>
  )
}

export default function ConversationGroup({ conversation, expanded, onToggle, onOpen, filtered }) {
  const {
    id, title, turns = [], turn_count: turnCount, first_at: firstAt, last_at: lastAt,
    error_count: errorCount, abstained_count: abstainedCount, matched_count: matchedCount,
    frameworks_cited: frameworks, cost_usd: cost, latency_ms: latency, tokens,
  } = conversation

  const multi = turnCount > 1
  const panelId = `conversation-${id}`

  return (
    <article className="item-in overflow-hidden rounded-xl border border-line bg-paper transition-shadow duration-300 ease-smooth hover:shadow-card">
      <header className="border-b border-line bg-paper-soft px-4 py-3.5 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <button
              type="button"
              onClick={() => onToggle(id)}
              aria-expanded={expanded}
              aria-controls={panelId}
              className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line-strong text-slate2 transition-colors duration-200 hover:border-navy hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-dark/30"
            >
              <span className="sr-only">{expanded ? 'Collapse this conversation' : 'Expand this conversation'}</span>
              <svg viewBox="0 0 10 10" className={`h-2.5 w-2.5 transition-transform duration-200 ease-smooth ${expanded ? 'rotate-90' : ''}`} aria-hidden="true">
                <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="min-w-0">
              <h2 className="truncate font-serif text-body font-semibold leading-[21px] text-navy" title={title || 'Untitled conversation'}>
                {title || 'Untitled conversation'}
              </h2>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-slate2">
                <span className={`rounded px-1.5 py-[1px] font-medium ${multi ? 'bg-teal-tint text-teal-dark' : 'bg-paper-tint text-slate2'}`}>
                  {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
                </span>
                <span className="tabular">{spanOfTime(firstAt, lastAt)}</span>
                <span className="text-slate2-light">{relTime(lastAt)}</span>
                {filtered && matchedCount < turnCount && (
                  <span className="text-slate2-light">{matchedCount} matching</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              <Figure label="Latency" value={fmtMs(latency)} />
              <Figure label="Tokens" value={fmtNum(tokens)} />
              <Figure label="Cost" value={fmtUsd(cost)} />
            </dl>
            <div className="flex flex-wrap gap-1.5 pt-[2px]">
              {errorCount > 0 && <StatusChip status="error">{errorCount} error</StatusChip>}
              {abstainedCount > 0 && <StatusChip status="abstained">{abstainedCount} abstained</StatusChip>}
            </div>
          </div>
        </div>

        {frameworks?.length > 0 && (
          <p className="mt-2 pl-8 text-meta text-slate2-light">
            Cites {frameworks.filter(Boolean).join(', ')}
          </p>
        )}
      </header>

      {expanded && (
        <div id={panelId}>
          <ol className="px-4 py-2 sm:px-5">
            {turns.map((turn, i) => (
              <Turn
                key={turn.id}
                turn={turn}
                index={i}
                total={turns.length}
                filtered={filtered}
                onOpen={onOpen}
              />
            ))}
          </ol>
          {multi && (
            <p className="border-t border-line px-4 py-2.5 text-meta text-slate2-light sm:px-5">
              Each turn was answered with the turns above it in context.{' '}
              <Link to={`/audit/${turns[turns.length - 1]?.id}`} className="link">
                Open the latest turn
              </Link>
            </p>
          )}
        </div>
      )}
    </article>
  )
}
