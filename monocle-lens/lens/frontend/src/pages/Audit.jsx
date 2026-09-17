import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ConversationGroup from '../components/ConversationGroup'
import StatusChip from '../components/StatusChip'
import { fmtMs, fmtNum, fmtUsd } from '../components/MetaStrip'
import { SkeletonTable } from '../components/Skeleton'
import { getConversations, getRuns } from '../api'

const TOOLS = ['search_corpus', 'fetch_section', 'compare_frameworks', 'classify_ai_act_risk', 'list_obligations']
const FRAMEWORKS = ['ss123', 'sr117', 'euaiact', 'popia', 'iso42001', 'bcbs239']
const EMPTY = { status: '', tool: '', framework: '', q: '', from: '', to: '' }
const VIEW_KEY = 'lens.audit.view'

function Field({ label, htmlFor, children, className = '' }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="field-label mb-1 block">
        {label}
      </label>
      {children}
    </div>
  )
}

/** The flat run list, unchanged: one row per turn, newest first. */
function RunTable({ runs, loading, onOpen }) {
  const openRow = (id) => (e) => {
    if (e.type === 'click' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(id)
    }
  }
  return (
    <div data-tour="audit-list" className="mt-6 overflow-x-auto">
      <table className="table-base min-w-[860px]">
        <caption className="sr-only">Agent runs, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Question</th>
            <th scope="col">Status</th>
            <th scope="col">Tools</th>
            <th scope="col" className="num">Chunks</th>
            <th scope="col" className="num">Latency</th>
            <th scope="col" className="num">Tokens</th>
            <th scope="col" className="num">Cost</th>
          </tr>
        </thead>
        <tbody className={loading ? 'opacity-60 transition-opacity duration-200' : 'transition-opacity duration-200'}>
          {runs.map((run) => (
            <tr
              key={run.id}
              tabIndex={0}
              role="link"
              aria-label={`Open the trace for: ${run.user_message}`}
              onClick={openRow(run.id)}
              onKeyDown={openRow(run.id)}
              className="row-link"
            >
              <td className="whitespace-nowrap tabular text-slate2">
                {new Date(run.started_at).toLocaleString()}
              </td>
              <td className="max-w-[380px]">
                <span className="line-clamp-2">{run.user_message}</span>
                {run.replay_of_run_id && <span className="mt-0.5 block text-meta text-slate2-light">replay</span>}
              </td>
              <td><StatusChip status={run.status} /></td>
              <td className="max-w-[200px] text-slate2">{run.tools_used?.join(', ') || '—'}</td>
              <td className="num">{run.chunks_retrieved}</td>
              <td className="num">{fmtMs(run.latency_ms)}</td>
              <td className="num">{fmtNum((run.input_tokens || 0) + (run.output_tokens || 0))}</td>
              <td className="num">{fmtUsd(run.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Two ways of reading the same history: as threads, or as a flat list of turns. */
function ViewToggle({ view, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-line-strong p-[2px]" role="group" aria-label="History view">
      {[['threads', 'Conversations'], ['turns', 'All turns']].map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={view === key}
          onClick={() => onChange(key)}
          className={`rounded px-3 py-1.5 text-meta font-medium transition-colors duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-dark/30 ${
            view === key ? 'bg-navy text-paper' : 'text-slate2 hover:bg-paper-tint hover:text-navy'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export default function Audit() {
  const navigate = useNavigate()
  const [filters, setFilters] = useState(EMPTY)
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'turns' ? 'turns' : 'threads'
    } catch {
      return 'threads'
    }
  })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  // Collapsed rather than expanded ids: threads read best open, so the default is open
  // and this records the ones deliberately shut.
  const [collapsed, setCollapsed] = useState(() => new Set())

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      /* a private window should still get a working screen */
    }
  }, [view])

  useEffect(() => {
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
    let live = true
    setLoading(true)
    setError(null)
    const request = view === 'threads' ? getConversations(params) : getRuns(params)
    request
      .then((res) => {
        if (live) setData(res.data)
      })
      .catch(() => {
        if (live) setError('The conversation history could not be loaded. Check the API container, then reload.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [filters, view])

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))
  const filtered = Object.values(filters).some(Boolean)

  const conversations = view === 'threads' ? data?.conversations || [] : []
  const runs = view === 'turns' ? data?.runs || [] : []
  const empty = view === 'threads' ? conversations.length === 0 : runs.length === 0

  const allCollapsed =
    conversations.length > 0 && conversations.every((c) => collapsed.has(String(c.id)))

  const toggle = (id) =>
    setCollapsed((current) => {
      const next = new Set(current)
      const key = String(id)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const setAll = (collapse) =>
    setCollapsed(collapse ? new Set(conversations.map((c) => String(c.id))) : new Set())

  const openRun = (id) => navigate(`/audit/${id}`)

  return (
    <div className="pb-16">
      <div data-tour="audit-header">
        <h1 className="page-title brand-rule">Conversation history</h1>
        <p className="page-deck">
          {view === 'threads'
            ? 'Every conversation ever run, newest first, with each turn in the thread it belongs to. Open a turn to replay exactly what the agent did.'
            : 'Every turn ever run, newest first. Open one to replay exactly what the agent did.'}
        </p>
      </div>

      <div data-tour="audit-filters" className="mt-8 rounded border border-line bg-paper-tint p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search questions" htmlFor="f-q" className="sm:col-span-2">
            <input id="f-q" className="input w-full" placeholder="Any text in the question" value={filters.q} onChange={set('q')} />
          </Field>
          <Field label="Status" htmlFor="f-status">
            <select id="f-status" className="select w-full" value={filters.status} onChange={set('status')}>
              <option value="">Any</option>
              <option value="ok">ok</option>
              <option value="abstained">abstained</option>
              <option value="error">error</option>
            </select>
          </Field>
          <Field label="Tool used" htmlFor="f-tool">
            <select id="f-tool" className="select w-full" value={filters.tool} onChange={set('tool')}>
              <option value="">Any</option>
              {TOOLS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Framework cited" htmlFor="f-framework">
            <select id="f-framework" className="select w-full" value={filters.framework} onChange={set('framework')}>
              <option value="">Any</option>
              {FRAMEWORKS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <Field label="From" htmlFor="f-from">
              <input id="f-from" type="date" className="input w-full" value={filters.from} onChange={set('from')} />
            </Field>
            <Field label="To" htmlFor="f-to">
              <input id="f-to" type="date" className="input w-full" value={filters.to} onChange={set('to')} />
            </Field>
          </div>
        </div>

        {filtered && (
          <button type="button" className="btn-quiet -ml-2 mt-3" onClick={() => setFilters(EMPTY)}>
            Clear filters
          </button>
        )}
      </div>

      <div data-tour="audit-view" className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <ViewToggle view={view} onChange={setView} />
        {view === 'threads' && conversations.length > 0 && (
          <button type="button" className="btn-quiet" onClick={() => setAll(!allCollapsed)}>
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>

      {error && <p className="notice-error mt-6">{error}</p>}

      {!error && loading && !data && <SkeletonTable rows={8} />}

      {!error && view === 'threads' && (data || !loading) && conversations.length > 0 && (
        <div
          data-tour="audit-list"
          className={`stagger mt-6 space-y-4 ${loading ? 'opacity-60 transition-opacity duration-200' : 'transition-opacity duration-200'}`}
        >
          {conversations.map((conversation) => (
            <ConversationGroup
              key={conversation.id}
              conversation={conversation}
              expanded={!collapsed.has(String(conversation.id))}
              onToggle={toggle}
              onOpen={openRun}
              filtered={filtered}
            />
          ))}
        </div>
      )}

      {!error && view === 'turns' && (data || !loading) && (
        <RunTable runs={runs} loading={loading} onOpen={openRun} />
      )}

      {/* A refetch behind existing content dims it rather than replacing it. */}
      {loading && data && (
        <p className="mt-4 text-meta text-slate2-light" role="status">
          Updating…
        </p>
      )}

      {!loading && data && empty && (
        <div className="mt-8 max-w-measure border-t border-line pt-5">
          <p className="text-body text-navy">
            {filtered
              ? `No ${view === 'threads' ? 'conversations' : 'runs'} match these filters.`
              : `No ${view === 'threads' ? 'conversations' : 'runs'} yet.`}
          </p>
          <p className="mt-1.5 text-body text-slate2">
            {filtered
              ? 'Widen the date range or clear a filter.'
              : <>Ask a question, or run <span className="font-mono text-navy">make seed</span> to populate the history.</>}
          </p>
        </div>
      )}

      {data && !empty && (
        <p className="mt-4 text-meta tabular text-slate2-light">
          {view === 'threads'
            ? `Showing ${conversations.length} of ${data.total} conversations — ${conversations.reduce(
                (n, c) => n + (c.turns?.length || 0),
                0,
              )} of ${data.total_runs} turns.`
            : `Showing ${runs.length} of ${data.total} runs.`}
        </p>
      )}
    </div>
  )
}
