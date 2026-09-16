import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Answer, { InlineText } from '../components/Answer'
import ConversationThread from '../components/ConversationThread'
import EvidenceDrawer from '../components/EvidenceDrawer'
import JsonBlock from '../components/JsonBlock'
import MetaStrip, { fmtMs, fmtNum, fmtUsd, sectionTail } from '../components/MetaStrip'
import SpanDetail from '../components/SpanDetail'
import StatusChip from '../components/StatusChip'
import TraceViews from '../components/TraceViews'
import { downloadExport, getRun, streamReplay } from '../api'

/** Did re-executing the pipeline land on the recorded answer? */
function ReproductionVerdict({ verdict }) {
  if (!verdict) return null
  const { identical, differences = [], replayed_calls: calls } = verdict
  return (
    <div
      className={`item-in mt-4 rounded-lg border p-5 ${
        identical ? 'border-teal-dark/30 bg-teal-tint' : 'border-brand-red/25 bg-brand-redTint'
      }`}
    >
      <p className={`text-section font-medium ${identical ? 'text-navy' : 'text-brand-redInk'}`}>
        {identical ? 'Reproduced exactly' : 'Did not reproduce exactly'}
      </p>
      <p className="mt-2 max-w-measure font-serif text-quote text-slate2">
        {identical
          ? `Retrieval, tools, guardrails and citation verification all ran again against the ${calls} model
             responses this run recorded, and produced the same answer and the same citations. The trace is a
             complete record of how this answer was reached.`
          : 'Re-executing the pipeline against the recorded model responses did not return the recorded answer. Everything that moved is listed below.'}
      </p>
      {differences.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {differences.map((d) => (
            <li key={d} className="flex gap-3 font-serif text-quote text-navy">
              <span className="mt-[11px] h-px w-3 shrink-0 bg-brand-red" aria-hidden="true" />
              {d}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Section({ title, note, children }) {
  return (
    <section className="mt-12">
      <div className="border-b border-line-strong pb-2">
        <h2 className="section-heading brand-rule">{title}</h2>
        {note && <p className="mt-1 text-meta text-slate2">{note}</p>}
      </div>
      {children}
    </section>
  )
}

/** Line-level comparison between the recorded answer and the replayed one.
 *  Lines that survived are muted; what changed carries a rule in its margin. */
function Diff({ original, replay }) {
  const a = (original || '').split('\n').filter(Boolean)
  const b = (replay || '').split('\n').filter(Boolean)
  const setA = new Set(a)
  const setB = new Set(b)

  const column = (lines, other, label, tone) => (
    <div>
      <p className="field-label mb-2">{label}</p>
      <div className="font-serif text-quote">
        {lines.map((line, i) => {
          const changed = !other.has(line)
          return (
            <p
              key={i}
              className={`border-l-2 py-[3px] pl-3 ${
                changed ? `${tone} text-navy` : 'border-transparent text-slate2'
              }`}
            >
              <InlineText>{line}</InlineText>
            </p>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="mt-4 grid gap-6 md:grid-cols-2">
      {column(a, setB, 'Recorded answer', 'border-brand-red bg-brand-redTint')}
      {column(b, setA, 'This run', 'border-teal-dark bg-paper-tint')}
    </div>
  )
}

export default function AuditDetail() {
  const { runId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [citation, setCitation] = useState(null)
  const [replay, setReplay] = useState(null)
  const [replaying, setReplaying] = useState(null)
  const abort = useRef(null)

  const load = useCallback(() => {
    getRun(runId)
      .then((res) => {
        setData(res.data)
        // Keep the selection across a reload of the same run; drop it when the spans
        // belong to a different run, as they do when a thread link moves between turns.
        setSelected((current) =>
          res.data.spans.some((s) => s.id === current)
            ? current
            : res.data.spans.find((s) => s.type !== 'agent')?.id || null,
        )
      })
      .catch(() => setError('This trace could not be loaded. It may have been removed, or the API is down.'))
  }, [runId])

  useEffect(() => {
    // Everything on this screen describes one run. Moving to another turn clears it
    // rather than leaving the previous run's panels standing under a new question.
    setData(null)
    setError(null)
    setReplay(null)
    setCitation(null)
    load()
  }, [load])

  // A replay still streaming when the reader moves to another turn would write its
  // tokens into the new page.
  useEffect(() => () => abort.current?.abort(), [runId])

  const runReplay = async (mode) => {
    setReplaying(mode)
    setReplay({ mode, answer: '', summary: null })
    abort.current = new AbortController()
    try {
      await streamReplay(runId, mode, (event, payload) => {
        if (event === 'token') setReplay((r) => ({ ...r, answer: r.answer + payload.text }))
        else if (event === 'done') setReplay((r) => ({ ...r, summary: payload }))
      }, abort.current.signal)
      load()
    } catch {
      setError(mode === 'reproduce'
        ? 'The reproduction could not be started. This run may predate response recording.'
        : 'The re-run could not be started. Check the API container, then try again.')
    } finally {
      setReplaying(null)
    }
  }

  if (error) return <p className="notice-error">{error}</p>
  if (!data) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the trace">
        <span className="sr-only">Loading the trace…</span>
        <span className="skeleton block h-3 w-40" aria-hidden="true" />
        <span className="skeleton mt-5 block h-6 w-3/4" aria-hidden="true" />
        <span className="skeleton mt-2.5 block h-6 w-1/2" aria-hidden="true" />
        <div className="mt-8 flex gap-8">
          {['w-20', 'w-16', 'w-24', 'w-16', 'w-20'].map((w) => (
            <span key={w} className={`skeleton block h-3 ${w}`} aria-hidden="true" />
          ))}
        </div>
        <div className="mt-10 space-y-2">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="skeleton block h-3 w-[200px] shrink-0" aria-hidden="true" />
              <span
                className="skeleton block h-[9px]"
                style={{ width: `${18 + ((i * 37) % 62)}%`, marginLeft: `${(i * 23) % 26}%` }}
                aria-hidden="true"
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const {
    run, spans, citations, guardrail_events: guardrails, prompts_used: prompts, replays,
    conversation, thread = [],
  } = data
  const span = spans.find((s) => s.id === selected)

  // A passage selected in the knowledge network opens in the same drawer a citation does.
  // Anything the retrievers ranked can be read, whether or not the answer quoted it.
  const openPassage = (chunk) =>
    setCitation(
      chunk.citation || {
        chunk_id: chunk.chunkId,
        short_name: chunk.shortName,
        section_path: chunk.sectionPath,
        quote: '',
      },
    )

  return (
    <div className="pb-16">
      <Link to="/audit" className="btn-quiet -ml-2">
        ← Conversation history
      </Link>

      <ConversationThread conversation={conversation} turns={thread} runId={run.id} />

      <div className="mt-4 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <h1 className="brand-rule max-w-measure font-serif text-[22px] font-semibold leading-[30px] text-navy">
          {run.user_message}
        </h1>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadExport(runId).catch(() =>
                setError('The audit pack could not be exported. Your session may have expired — reload and try again.'))
            }
          >
            Export audit pack
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => runReplay('live')}
            disabled={!!replaying}
            title="Ask the question again against the current prompts. The answer may differ."
          >
            {replaying === 'live' ? (
              <>
                <span className="pulse h-1.5 w-1.5 rounded-full bg-navy" aria-hidden="true" />
                Re-running
              </>
            ) : (
              'Re-run against current prompts'
            )}
          </button>
          <button
            type="button"
            className="btn-brand"
            onClick={() => runReplay('reproduce')}
            disabled={!!replaying}
            title="Re-execute the pipeline against this run's recorded model responses. The answer must come out identical."
          >
            {replaying === 'reproduce' ? (
              <>
                <span className="pulse h-1.5 w-1.5 rounded-full bg-paper" aria-hidden="true" />
                Reproducing
              </>
            ) : (
              'Reproduce this run'
            )}
          </button>
        </div>
      </div>

      <div className="mt-5">
        <MetaStrip
          items={[
            ['Status', <StatusChip key="s" status={run.status} />],
            ['Confidence', run.confidence == null ? '—' : Number(run.confidence).toFixed(2)],
            ['Model', run.model, true],
            ['Prompts', run.prompt_bundle_hash, true],
            ['Config', run.config_hash, true],
            ['Latency', fmtMs(run.latency_ms)],
            ['Tokens in / out', `${fmtNum(run.input_tokens)} / ${fmtNum(run.output_tokens)}`],
            ['Cost', fmtUsd(run.cost_usd)],
            ['Source', run.llm_source, true],
            ['Trace id', run.trace_id, true],
          ]}
        />
      </div>

      {run.error && <p className="notice-error mt-5">{run.error}</p>}

      {run.final_answer && (
        <section
          className={`mt-7 max-w-[760px] rounded border border-line p-5 sm:p-6 ${
            run.status === 'abstained' ? 'border-l-2 border-l-slate2 bg-paper-tint' : ''
          }`}
        >
          <Answer text={run.final_answer} citations={citations} onCitation={setCitation} />
        </section>
      )}

      <Section
        title="How this answer was reached"
        note={`${spans.length} recorded spans, read three ways. Selecting a step anywhere shows exactly what it sent and received.`}
      >
        <TraceViews
          run={run}
          spans={spans}
          guardrails={guardrails}
          citations={citations}
          selected={selected}
          onSelect={setSelected}
          onOpenChunk={openPassage}
          inspector={<SpanDetail span={span} />}
        />
        <div className="mt-7 border-t border-line pt-1">
          <SpanDetail span={span} />
        </div>
      </Section>

      <Section title="Evidence" note="Each citation as it appears in the answer, with the passage it rests on.">
        {citations.length === 0 ? (
          <p className="mt-4 text-body text-slate2">
            No citations. This run did not produce an answer.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="table-base min-w-[760px]">
              <thead>
                <tr>
                  <th scope="col">Marker</th>
                  <th scope="col">Document</th>
                  <th scope="col">Section</th>
                  <th scope="col">Quoted passage</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {citations.map((c) => (
                  <tr key={c.id}>
                    <td className="font-mono">{c.marker}</td>
                    <td className="whitespace-nowrap">{c.short_name}</td>
                    <td className="max-w-[220px] truncate" title={c.section_path}>
                      {sectionTail(c.section_path)}
                    </td>
                    <td className="max-w-[420px]">
                      <button
                        type="button"
                        className="text-left font-serif text-body leading-[19px] text-navy underline decoration-line decoration-1 underline-offset-2 transition-colors hover:decoration-teal-dark"
                        onClick={() => setCitation(c)}
                      >
                        “{c.quote}”
                      </button>
                    </td>
                    <td>
                      {c.source_url && (
                        <a href={c.source_url} target="_blank" rel="noreferrer" className="link">
                          Original
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Guardrails" note="What was checked before the answer was allowed out.">
        {guardrails.length === 0 ? (
          <p className="mt-4 text-body text-slate2">No guardrail events were recorded for this run.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="table-base min-w-[640px]">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {guardrails.map((event) => (
                  <tr key={event.id}>
                    <td className="whitespace-nowrap">{event.kind}</td>
                    <td>
                      <StatusChip
                        status={event.verdict === 'pass' || event.verdict === 'answer' ? 'ok' : 'abstained'}
                      >
                        {event.verdict}
                      </StatusChip>
                    </td>
                    <td className="[&>div]:mt-0">
                      <JsonBlock value={event.detail_json} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Provenance" note="Everything needed to reproduce this run exactly.">
        <dl className="mt-4 grid gap-x-10 md:grid-cols-2">
          {[
            ['Prompt versions', prompts.map((p) => `${p.name}@${p.hash}`).join(', ') || '—', true],
            ['Started', new Date(run.started_at).toLocaleString(), false],
            ['Question hash', run.question_hash, true],
          ].map(([label, value, mono]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-line py-2 text-body">
              <dt className="shrink-0 text-slate2">{label}</dt>
              <dd className={`truncate text-right ${mono ? 'font-mono' : ''}`} title={String(value)}>
                {value}
              </dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-b border-line py-2 text-body">
            <dt className="shrink-0 text-slate2">Replays</dt>
            <dd className="text-right">
              {replays.length === 0
                ? '—'
                : replays.map((r) => (
                    <Link key={r.id} to={`/audit/${r.id}`} className="link ml-3">
                      {new Date(r.started_at).toLocaleTimeString()}
                    </Link>
                  ))}
            </dd>
          </div>
        </dl>
        <JsonBlock label="Configuration used" value={run.config_json} />
        {run.fault_injection && <JsonBlock label="Deliberate fault injected" value={run.fault_injection} />}
      </Section>

      {replay && (
        <Section
          title={replay.mode === 'reproduce'
            ? 'Reproduction from the recorded trace'
            : 'Re-run against the current prompt version'}
          note={replay.mode === 'reproduce'
            ? 'The recorded model responses, with every other stage executed again. This answer must match.'
            : 'The same question, asked again now. What changed is what change control has to explain.'}
        >
          {replay.mode === 'reproduce' && <ReproductionVerdict verdict={replay.summary?.reproduction} />}
          {replay.summary && (
            <div className="mt-4">
              <MetaStrip
                items={[
                  ['Status', <StatusChip key="s" status={replay.summary.status} />],
                  ['Prompts', `${run.prompt_bundle_hash} → ${replay.summary.prompt_version}`, true],
                  ['Cost', `${fmtUsd(run.cost_usd)} → ${fmtUsd(replay.summary.cost_usd)}`],
                  ['Citations', `${citations.length} → ${replay.summary.citations.length}`],
                  ['Latency', `${fmtMs(run.latency_ms)} → ${fmtMs(replay.summary.latency_ms)}`],
                  replay.mode === 'reproduce'
                    ? ['Model responses', 'replayed from this trace']
                    : null,
                ]}
              />
            </div>
          )}
          <Diff original={run.final_answer} replay={replay.answer} />
        </Section>
      )}

      {citation && <EvidenceDrawer citation={citation} onClose={() => setCitation(null)} />}
    </div>
  )
}
