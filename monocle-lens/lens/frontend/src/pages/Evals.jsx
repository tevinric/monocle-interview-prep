import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import StatusChip from '../components/StatusChip'
import { fmtMs, fmtUsd } from '../components/MetaStrip'
import { getEvals, streamEvalRun } from '../api'

// Metrics are stored under their machine keys; read them under their names.
const METRIC_LABELS = {
  citation_precision: 'Citation precision',
  groundedness: 'Groundedness',
  retrieval_hit_rate_at_8: 'Retrieval hit rate @8',
  abstention_correctness: 'Abstention correctness',
  latency_p50_ms: 'Latency, median',
  latency_p95_ms: 'Latency, 95th percentile',
  latency_ms: 'Latency',
  cost_usd: 'Cost per question',
  cost_per_question_usd: 'Cost per question',
  must_cite: 'Cited the expected section',
  status: 'Completed without error',
}

const labelFor = (metric) => METRIC_LABELS[metric] || metric.replace(/_/g, ' ')

const fmtValue = (metric, value) => {
  if (value == null) return '—'
  if (metric.includes('ms')) return fmtMs(Number(value))
  if (metric.includes('cost')) return fmtUsd(value)
  return Number(value).toFixed(3)
}

/**
 * Starting a batch costs real money and takes minutes, so the button says what it will
 * do before it does it rather than leaving someone to find out.
 */
function RunPanel({ questionSet, onRun, progress, running, error, hasResults }) {
  const count = questionSet?.count
  const done = progress?.done ?? 0
  const total = progress?.total ?? count ?? 0
  const pct = total ? Math.round((done / total) * 100) : 0

  if (running) {
    return (
      <div className="mt-7 rounded-xl border border-line bg-paper-soft p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="flex items-center gap-3 text-section font-medium text-navy">
            <span className="live h-2.5 w-2.5 shrink-0 rounded-full bg-teal-dark" aria-hidden="true" />
            Scoring the question set
          </p>
          <p className="text-body tabular text-slate2">
            {done} of {total} questions
          </p>
        </div>

        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar"
             aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
          <div
            className="h-full rounded-full bg-gradient-to-r from-teal-dark to-teal transition-[width] duration-500 ease-smooth"
            style={{ width: `${pct}%` }}
          />
        </div>

        {progress?.latest?.length > 0 && (
          <ul className="mt-5 space-y-1.5" aria-live="polite">
            {progress.latest.map((q) => (
              <li key={q.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-table">
                <span className={q.ok ? 'text-teal-dark' : 'text-brand-redInk'}>{q.ok ? 'ok' : 'fail'}</span>
                <span className="font-mono text-meta text-slate2-light">{q.key}</span>
                <span className="min-w-0 flex-1 truncate text-slate2">{q.question}</span>
                <span className="tabular text-slate2-light">{fmtMs(q.latency_ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div data-tour="evals-metrics" className="mt-7 rounded-xl border border-line bg-paper-soft p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="max-w-measure">
          <p className="text-section font-medium text-navy">
            {hasResults ? 'Run the question set again' : 'No evaluation has been run yet'}
          </p>
          <p className="mt-2 font-serif text-quote text-slate2">
            {count ? `All ${count} questions` : 'Every question in the set'} run through the real agent and
            are scored against the thresholds that ship with them. That takes a few minutes and costs about
            as much as answering {count ? `${count} questions` : 'the whole set'} normally, so it runs only
            when you ask.
          </p>
        </div>
        <button type="button" className="btn-primary shrink-0" onClick={onRun}>
          Run evaluation
        </button>
      </div>

      {error && <p className="notice-error mt-5">{error}</p>}

      <p className="mt-5 border-t border-line pt-4 text-meta text-slate2-light">
        The same run is available on the command line as{' '}
        <span className="font-mono text-slate2">make eval</span>, and{' '}
        <span className="font-mono text-slate2">make eval --only &lt;key&gt;</span> scores a single question.
      </p>
    </div>
  )
}

export default function Evals() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [runError, setRunError] = useState(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const abort = useRef(null)

  const load = useCallback(() => {
    getEvals()
      .then((res) => setData(res.data))
      .catch(() => setError('The evaluation results could not be loaded. Check the API container, then reload.'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async () => {
    setRunning(true)
    setRunError(null)
    setProgress({ done: 0, total: data?.question_set?.count ?? 0, latest: [] })
    abort.current = new AbortController()
    try {
      await streamEvalRun((event, payload) => {
        if (event === 'batch') {
          setProgress((p) => ({ ...p, total: payload.total }))
        } else if (event === 'question') {
          setProgress((p) => ({
            done: payload.index,
            total: payload.total,
            // Newest first, and only the last few — this is reassurance, not a report.
            latest: [payload, ...(p?.latest || [])].slice(0, 6),
          }))
        } else if (event === 'error') {
          setRunError(payload.message)
        }
      }, abort.current.signal)
      load()
    } catch {
      setRunError('The evaluation could not be started. Check that the API container is running.')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const summary = data?.summary || []
  const judged = summary.filter((r) => r.passed != null)
  const met = judged.filter((r) => r.passed).length
  const allMet = judged.length > 0 && met === judged.length

  const byQuestion = {}
  ;(data?.questions || []).forEach((row) => {
    const entry = (byQuestion[row.question_key] ||= {
      key: row.question_key,
      run_id: row.run_id,
      metrics: {},
      user_message: row.user_message,
      status: row.run_status,
    })
    entry.metrics[row.metric] = row.value
  })

  return (
    <div className="pb-16">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div data-tour="evals-header">
          <h1 className="page-title brand-rule">Last evaluation run</h1>
          <p className="page-deck">
            Thresholds live with the question set, so the run reports pass or fail rather than a number that
            needs interpreting. Every row links to the trace it came from.
          </p>
        </div>
        {summary.length > 0 && !running && (
          <button type="button" className="btn shrink-0" onClick={run}>
            Run again
          </button>
        )}
      </div>

      {error && <p className="notice-error mt-6">{error}</p>}

      {data && (summary.length === 0 || running) && (
        <RunPanel
          questionSet={data.question_set}
          onRun={run}
          progress={progress}
          running={running}
          error={runError}
          hasResults={summary.length > 0}
        />
      )}

      {runError && !running && summary.length > 0 && <p className="notice-error mt-6">{runError}</p>}

      {summary.length > 0 && (
        <>
          {/* The result of the run, before the numbers that produced it. */}
          <p
            className={`mt-8 border-y py-5 text-section font-medium ${
              allMet ? 'border-line text-navy' : 'border-brand-red/30 text-brand-redInk'
            }`}
          >
            {met} of {judged.length} thresholds met
          </p>

          <h2 className="section-heading brand-rule mt-10">Metrics</h2>
          <div data-tour="evals-metrics" className="mt-4 overflow-x-auto">
            <table className="table-base min-w-[640px]">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col" className="num">Value</th>
                  <th scope="col" className="num">Threshold</th>
                  <th scope="col">Result</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.id}>
                    <td className="font-normal">{labelFor(row.metric)}</td>
                    <td className="num font-medium">{fmtValue(row.metric, row.value)}</td>
                    <td className="num text-slate2">{fmtValue(row.metric, row.threshold)}</td>
                    <td>
                      {row.passed == null ? (
                        '—'
                      ) : (
                        <StatusChip status={row.passed ? 'pass' : 'fail'}>
                          {row.passed ? 'pass' : 'fail'}
                        </StatusChip>
                      )}
                    </td>
                    <td className="text-slate2">{row.notes || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="section-heading brand-rule mt-12">Questions</h2>
          <div data-tour="evals-questions" className="mt-4 overflow-x-auto">
            <table className="table-base min-w-[980px]">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Retrieval</th>
                  <th scope="col" className="num">Precision</th>
                  <th scope="col" className="num">Grounded</th>
                  <th scope="col" className="num">Abstention</th>
                  <th scope="col" className="num">Latency</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col">Trace</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(byQuestion).map((row) => (
                  <tr key={row.key}>
                    <td className="max-w-[320px]">
                      <p className="line-clamp-1 text-navy">{row.user_message}</p>
                      <span className="font-mono text-meta text-slate2-light">{row.key}</span>
                    </td>
                    <td><StatusChip status={row.status} /></td>
                    <td className="num">
                      {row.metrics.retrieval_hit_at_8 == null
                        ? '—'
                        : row.metrics.retrieval_hit_at_8 > 0
                          ? 'hit'
                          : 'miss'}
                    </td>
                    <td className="num">{fmtValue('citation_precision', row.metrics.citation_precision)}</td>
                    <td className="num">{fmtValue('groundedness', row.metrics.groundedness)}</td>
                    <td className="num">
                      {row.metrics.abstention_correct == null
                        ? '—'
                        : row.metrics.abstention_correct > 0
                          ? 'correct'
                          : 'wrong'}
                    </td>
                    <td className="num">{fmtMs(Number(row.metrics.latency_ms))}</td>
                    <td className="num">{fmtUsd(row.metrics.cost_usd)}</td>
                    <td>
                      {row.run_id && (
                        <Link to={`/audit/${row.run_id}`} className="link">
                          Open
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
