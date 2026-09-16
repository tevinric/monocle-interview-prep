import { Link } from 'react-router-dom'
import StatusChip from './StatusChip'
import { fmtMs, fmtUsd } from './MetaStrip'

/**
 * The thread this turn belongs to, on the trace page.
 *
 * A follow-up cannot be judged on its own: "who would count as independent?" is only
 * answerable against the question before it. This places the turn in its conversation
 * and makes every sibling one click away, without taking anything off the trace itself.
 */
export default function ConversationThread({ conversation, turns = [], runId }) {
  if (turns.length < 2) return null

  const index = turns.findIndex((t) => String(t.id) === String(runId))
  const previous = index > 0 ? turns[index - 1] : null
  const next = index >= 0 && index < turns.length - 1 ? turns[index + 1] : null

  return (
    <nav
      aria-label="Turns in this conversation"
      className="mt-4 overflow-hidden rounded-xl border border-line bg-paper-soft"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line px-4 py-2.5">
        <p className="min-w-0 text-meta text-slate2">
          <span className="font-medium text-navy">Conversation</span>
          <span className="mx-2 text-slate2-light">·</span>
          <span className="tabular">{turns.length} turns</span>
          <span className="mx-2 text-slate2-light">·</span>
          <span className="tabular">turn {index >= 0 ? index + 1 : '—'} of {turns.length}</span>
        </p>
        {conversation?.title && (
          <p className="truncate font-serif text-meta text-slate2-light" title={conversation.title}>
            {conversation.title}
          </p>
        )}
      </div>

      <ol className="px-4 py-2">
        {turns.map((turn, i) => {
          const current = String(turn.id) === String(runId)
          const body = (
            <>
              <span
                aria-hidden="true"
                className={`absolute left-[7px] top-[11px] flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[10px] font-semibold tabular ${
                  current ? 'border-brand-red bg-brand-red text-paper' : 'border-line-strong bg-paper text-slate2'
                }`}
              >
                {i + 1}
              </span>
              <span className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
                <span
                  className={`max-w-measure flex-1 font-serif text-body leading-[21px] ${
                    current ? 'font-semibold text-navy' : 'text-slate2'
                  }`}
                >
                  {turn.user_message}
                  {turn.replay_of_run_id && (
                    <span className="ml-2 align-middle text-meta text-slate2-light">replay</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3 text-meta tabular text-slate2-light">
                  <StatusChip status={turn.status} />
                  <span>{fmtMs(turn.latency_ms)}</span>
                  <span>{fmtUsd(turn.cost_usd)}</span>
                  <span>{new Date(turn.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </span>
              </span>
            </>
          )

          return (
            <li key={turn.id} className="relative">
              {/* The rail runs between the ordinals, stopping at the ends of the thread. */}
              <span
                aria-hidden="true"
                className={`absolute left-[15px] w-px bg-line ${
                  i === 0 ? 'top-[20px] bottom-0' : i === turns.length - 1 ? 'top-0 h-[20px]' : 'inset-y-0'
                }`}
              />
              {current ? (
                <div
                  aria-current="true"
                  className="relative block rounded-md bg-paper px-3 py-2 pl-11 ring-1 ring-inset ring-line"
                >
                  {body}
                  <span className="sr-only"> — the turn being audited</span>
                </div>
              ) : (
                <Link
                  to={`/audit/${turn.id}`}
                  className="relative block rounded-md px-3 py-2 pl-11 transition-colors duration-200 ease-smooth hover:bg-paper focus-visible:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-dark/30"
                >
                  {body}
                </Link>
              )}
            </li>
          )
        })}
      </ol>

      <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-2">
        {previous ? (
          <Link to={`/audit/${previous.id}`} className="btn-quiet -ml-2 max-w-[45%]">
            <span className="truncate">← Previous turn</span>
          </Link>
        ) : (
          <span className="text-meta text-slate2-light">First turn in this conversation</span>
        )}
        {next ? (
          <Link to={`/audit/${next.id}`} className="btn-quiet -mr-2 max-w-[45%]">
            <span className="truncate">Next turn →</span>
          </Link>
        ) : (
          <span className="text-meta text-slate2-light">Latest turn in this conversation</span>
        )}
      </div>
    </nav>
  )
}
