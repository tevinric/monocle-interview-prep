import JsonBlock from './JsonBlock'
import StatusChip from './StatusChip'
import { Stat, fmtMs, fmtNum, fmtUsd, sectionTail } from './MetaStrip'

/** The exact prompt as it was rendered and sent, role by role. */
function Messages({ messages }) {
  if (!messages) return null
  return (
    <div className="mt-4 space-y-3">
      <p className="field-label">Rendered prompt</p>
      {messages.map((message, i) => (
        <div key={i} className="rounded border border-line">
          <p className="border-b border-line bg-paper-tint px-3 py-1.5 text-meta font-medium text-slate2">
            {message.role}
          </p>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-json">
            {message.content}
          </pre>
        </div>
      ))}
    </div>
  )
}

/** Every candidate the retriever considered. Rows that did not reach the answer
 *  are muted rather than hidden — what was rejected is part of the record. */
function Retrieved({ rows }) {
  if (!rows?.length) return null
  const used = rows.filter((r) => r.used_in_answer).length
  return (
    <div className="mt-6">
      <p className="field-label">
        Candidates — {rows.length} considered, {used} used in the answer
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="table-base min-w-[880px]">
          <thead>
            <tr>
              <th scope="col">Retriever</th>
              <th scope="col" className="num">Rank</th>
              <th scope="col" className="num">Score</th>
              <th scope="col">Document</th>
              <th scope="col">Section</th>
              <th scope="col">Preview</th>
              <th scope="col">Used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.used_in_answer ? '' : 'text-slate2-light'}>
                <td>{row.retriever}</td>
                <td className="num">{row.rank}</td>
                <td className="num">{row.score == null ? '—' : Number(row.score).toFixed(4)}</td>
                <td className="whitespace-nowrap">{row.short_name}</td>
                <td className="max-w-[240px] truncate" title={row.section_path}>
                  {sectionTail(row.section_path)}
                </td>
                <td className="max-w-[320px] truncate" title={row.preview}>
                  {row.preview}
                </td>
                <td>{row.used_in_answer ? <StatusChip status="ok">used</StatusChip> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SpanDetail({ span }) {
  if (!span) {
    return (
      <p className="mt-6 max-w-measure text-body text-slate2">
        Select a step in the timeline to see exactly what it did.
      </p>
    )
  }
  const attributes = span.attributes_json || {}
  const output = span.output_json || {}

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h3 className="text-section font-medium text-navy">{span.name}</h3>
        <div className="flex items-center gap-3 text-meta text-slate2">
          <StatusChip status={span.status === 'running' ? 'pending' : span.status} />
          <span className="tabular">{fmtMs(span.duration_ms)}</span>
          <span className="font-mono text-slate2-light">{span.type}</span>
        </div>
      </div>

      {span.error && <p className="notice-error mt-3">{span.error}</p>}

      {span.type === 'llm' && (
        <>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Model" value={attributes.model} />
            <Stat
              label="Prompt"
              value={`${attributes.prompt_name}@${attributes.prompt_version}`}
              mono
            />
            {attributes.reasoning_effort ? (
              <Stat label="Reasoning effort" value={attributes.reasoning_effort} />
            ) : (
              <Stat label="Temperature" value={attributes.temperature} />
            )}
            <Stat
              label={attributes.max_completion_tokens ? 'Max completion tokens' : 'Max tokens'}
              value={fmtNum(attributes.max_completion_tokens ?? attributes.max_tokens)}
            />
            {attributes.reasoning_tokens ? (
              <Stat label="Reasoning tokens" value={fmtNum(attributes.reasoning_tokens)} />
            ) : null}
            <Stat
              label="Tokens in / out"
              value={`${fmtNum(attributes.input_tokens)} / ${fmtNum(attributes.output_tokens)}`}
            />
            <Stat label="Cost" value={fmtUsd(attributes.cost_usd)} />
            <Stat label="Finish reason" value={attributes.finish_reason || output.finish_reason || '—'} />
            <Stat
              label="Source"
              value={`${attributes.llm_source ?? '—'}${
                attributes.recording_match ? ` (${attributes.recording_match})` : ''
              }`}
            />
          </dl>
          <Messages messages={span.input_json?.messages} />
          {span.input_json?.response_format && (
            <JsonBlock label="Response schema" value={span.input_json.response_format} />
          )}
          <JsonBlock label="Raw response" value={output} />
        </>
      )}

      {span.type === 'tool' &&
        span.tool_calls?.map((call) => (
          <div key={call.id}>
            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Tool" value={call.tool_name} />
              <Stat label="Duration" value={fmtMs(call.duration_ms)} />
              <Stat label="Result" value={call.ok ? 'ok' : 'error'} />
            </dl>
            <JsonBlock label="Arguments" value={call.arguments_json} />
            {call.error && <JsonBlock label="Error" value={call.error} />}
            <JsonBlock label="Result" value={call.result_json} />
          </div>
        ))}

      {span.type === 'retrieval' && (
        <>
          <JsonBlock label="Query" value={span.input_json} />
          <JsonBlock label="Parameters" value={attributes} />
        </>
      )}

      {span.type === 'guardrail' && (
        <>
          <JsonBlock label="Input" value={span.input_json} />
          <JsonBlock label="Verdict" value={output} />
        </>
      )}

      {span.type === 'agent' && (
        <>
          <JsonBlock label="Input" value={span.input_json} />
          <JsonBlock label="Output" value={output} />
        </>
      )}

      <Retrieved rows={span.retrieved} />
    </div>
  )
}
