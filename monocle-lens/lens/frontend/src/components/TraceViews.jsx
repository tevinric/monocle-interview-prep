import { useEffect, useRef, useState } from 'react'
import FlowMap from './FlowMap'
import KnowledgeMap from './KnowledgeMap'
import Waterfall from './Waterfall'
import { FLOW_COLOURS, FLOW_LEGEND } from './flow/model'

const VIEWS = [
  ['flow', 'Flow', 'Every recorded step, in the order one fed the next. Select a step to see what it sent and received.'],
  ['knowledge', 'Knowledge', 'What the retrievers reached in the corpus, and which passages survived into the answer.'],
  ['timeline', 'Timeline', 'The same steps against the clock: each bar starts where that step started and is as wide as it took.'],
]

const STORE = 'lens.trace.view'
const STORE_DETAIL = 'lens.trace.detail'

// localStorage is unavailable in some privacy modes; a remembered view is a convenience,
// never a requirement.
function remembered(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key)
    return allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

function remember(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function Segmented({ value, onChange, options, label }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex rounded-md border border-line bg-paper-tint p-[3px]"
    >
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={`rounded-[5px] px-3 py-1.5 text-meta font-medium transition-all duration-200 ease-smooth ${
            value === key
              ? 'bg-paper text-navy shadow-card'
              : 'text-slate2 hover:text-navy'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-meta text-slate2">
      {FLOW_LEGEND.map(([kind, what]) => (
        <span key={kind} className="flex items-center gap-1.5" title={what}>
          <span
            className="h-[3px] w-4 rounded-[1px]"
            style={{ background: FLOW_COLOURS[kind] }}
            aria-hidden="true"
          />
          {kind}
        </span>
      ))}
    </div>
  )
}

/**
 * Three readings of one trace, behind a switch.
 *
 * The timeline is unchanged and still the record of when things ran. The flow map is the
 * same spans read as a workflow — what the agent did, and what fed what. The knowledge
 * network is what it read. All three select the same span, so the detail panel below is
 * driven identically whichever one a reader is in.
 */
export default function TraceViews({
  run, spans, guardrails, citations, selected, onSelect, onOpenChunk, inspector,
}) {
  const [view, setView] = useState(() => remembered(STORE, ['flow', 'knowledge', 'timeline'], 'flow'))
  const [detail, setDetail] = useState(() => remembered(STORE_DETAIL, ['overview', 'full'], 'overview'))
  const [expanded, setExpanded] = useState(false)
  const closeRef = useRef(null)

  useEffect(() => remember(STORE, view), [view])
  useEffect(() => remember(STORE_DETAIL, detail), [detail])

  // The guided tour walks all three readings of a trace in turn, and asks for each one
  // by event rather than by prop: this component is where the choice lives, the tour is
  // not always mounted, and neither should have to know about the other. The remembered
  // view is written as usual, so the last one the tour showed is the one left behind.
  useEffect(() => {
    const onRequest = (e) => {
      const wanted = e.detail
      if (['flow', 'knowledge', 'timeline'].includes(wanted)) setView(wanted)
    }
    window.addEventListener('lens:tour-trace-view', onRequest)
    return () => window.removeEventListener('lens:tour-trace-view', onRequest)
  }, [])

  useEffect(() => {
    if (!expanded) return undefined
    closeRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded])

  const selectSpan = (node) => {
    if (node.spanId) onSelect(node.spanId)
  }

  const note = VIEWS.find(([key]) => key === view)?.[2]

  const body = (height) => {
    if (view === 'timeline') {
      return <Waterfall run={run} spans={spans} selected={selected} onSelect={onSelect} />
    }
    if (view === 'knowledge') {
      return (
        <KnowledgeMap
          run={run}
          spans={spans}
          citations={citations}
          onOpenChunk={onOpenChunk}
          height={height}
        />
      )
    }
    return (
      <>
        <FlowMap
          run={run}
          spans={spans}
          guardrails={guardrails}
          detail={detail}
          selected={selected}
          onSelect={selectSpan}
          height={height}
        />
        <Legend />
      </>
    )
  }

  const controls = (inOverlay) => (
    <div className="flex flex-wrap items-center gap-2">
      {view === 'flow' && (
        <Segmented
          label="How much of the trace to draw"
          value={detail}
          onChange={setDetail}
          options={[['overview', 'Overview'], ['full', 'Every span']]}
        />
      )}
      <button
        type="button"
        className="btn-quiet"
        onClick={() => setExpanded(!inOverlay)}
        ref={inOverlay ? closeRef : undefined}
      >
        {inOverlay ? 'Close' : 'Expand'}
      </button>
    </div>
  )

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <Segmented
          label="How to read this trace"
          value={view}
          onChange={setView}
          options={VIEWS.map(([key, text]) => [key, text])}
        />
        {controls(false)}
      </div>
      <p className="mt-2.5 max-w-measure text-meta text-slate2">{note}</p>
      <div className="mt-3">{!expanded && body(420)}</div>

      {expanded && (
        <>
          <div className="veil fixed inset-0 z-30 bg-navy-deep/40 backdrop-blur-[1px]" aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${VIEWS.find(([key]) => key === view)?.[1]} — expanded`}
            className="item-in fixed inset-3 z-40 flex flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-lift sm:inset-6"
          >
            <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-3">
              <div className="min-w-0">
                <p className="eyebrow">This run</p>
                <h2 className="mt-0.5 truncate text-section font-medium text-navy">{run.user_message}</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="How to read this trace"
                  value={view}
                  onChange={setView}
                  options={VIEWS.map(([key, text]) => [key, text])}
                />
                {controls(true)}
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-auto scroll-slim px-5 py-4">
              {body(Math.max(320, Math.round(window.innerHeight * 0.52)))}
              <div className="mt-6 border-t border-line pt-1">{inspector}</div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
