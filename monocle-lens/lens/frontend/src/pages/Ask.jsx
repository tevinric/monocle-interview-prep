import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Answer from '../components/Answer'
import EvidenceDrawer from '../components/EvidenceDrawer'
import { fmtMs, fmtNum, fmtUsd } from '../components/MetaStrip'
import StatusChip from '../components/StatusChip'
import { streamChat } from '../api'

const EXAMPLES = [
  'What does SS1/23 require for independent model validation, and how does that compare with SR 11-7?',
  'A bank wants an LLM to draft credit decline letters sent to customers. Under the EU AI Act, what risk tier is that and what obligations follow?',
  'Under POPIA, what applies when client personal information is sent to a third-party LLM provider?',
  'What evidence would a second line typically expect before approving a GenAI use case that touches customer data?',
]

const PLACEHOLDER = 'Ask about SS1/23, SR 11-7, the EU AI Act, POPIA, ISO/IEC 42001 or BCBS 239…'

// The backend keeps the last five messages of the thread and no more. The client
// sends exactly that many, so both ends agree on what the agent could have seen.
const MEMORY_MESSAGES = 5

/** The agent's mark. The diagonal alone — the wordmark is illegible at this size. */
function AgentAvatar({ className = 'h-8 w-8' }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg bg-navy ${className}`}
      aria-hidden="true"
    >
      <span className="h-[45%] w-[3px] -skew-x-[18deg] rounded-[1px] bg-brand-red" />
    </span>
  )
}

/** Who you are talking to and what it does. The chat has no other preamble. */
function ChatHeader({ onReset, canReset }) {
  return (
    <header className="flex shrink-0 items-center gap-3.5 border-b border-line bg-paper py-4">
      <AgentAvatar className="h-10 w-10" />
      <div className="min-w-0">
        <h1 className="text-[16px] font-semibold leading-tight tracking-[-0.01em] text-navy">
          Monocle Lens
        </h1>
        <p className="mt-0.5 truncate text-meta text-slate2">
          Regulatory research agent — answers from six public frameworks, every claim cited
          to the passage it came from.
        </p>
      </div>
      {canReset && (
        <button type="button" onClick={onReset} className="btn-quiet ml-auto shrink-0">
          New chat
        </button>
      )}
    </header>
  )
}

/**
 * What the agent is doing, in the thread, while it does it.
 *
 * Open and live while the run is in flight; once the answer lands it folds to a
 * single line, because by then the working is evidence rather than something to
 * keep reading. Reopening it is one click.
 */
function Thinking({ steps, running, latency }) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (running) setOpen(true)
    else if (steps.length) setOpen(false)
  }, [running, steps.length])

  if (!steps.length && !running) return null

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-paper-soft">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-200 ease-smooth hover:bg-paper-tint"
      >
        <span className="flex items-center gap-2.5">
          {running ? (
            <span className="live h-2 w-2 shrink-0 rounded-full bg-teal-dark" aria-hidden="true" />
          ) : (
            <span className="h-2 w-2 shrink-0 rounded-full bg-teal" aria-hidden="true" />
          )}
          <span className="text-table font-medium text-navy">
            {running ? 'Thinking' : `Worked through ${steps.length} steps`}
          </span>
          {!running && latency != null && (
            <span className="text-meta tabular text-slate2-light">{fmtMs(latency)}</span>
          )}
        </span>
        <span className="text-meta font-medium text-slate2 transition-colors duration-200 ease-smooth group-hover:text-navy">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      {open && (
        <ol className="border-t border-line px-4 py-3" aria-live="polite">
          {steps.map((step, i) => (
            <li key={i} className="step-in flex gap-3 py-1">
              <span
                className={`mt-[9px] h-px shrink-0 transition-all duration-300 ease-smooth ${
                  step.failed
                    ? 'w-4 bg-brand-red'
                    : step.strong
                      ? 'w-4 bg-teal-dark'
                      : 'w-3 bg-line-strong'
                }`}
                aria-hidden="true"
              />
              <span
                className={`text-table ${
                  step.failed
                    ? 'text-brand-redInk'
                    : step.strong
                      ? 'font-medium text-navy'
                      : 'text-slate2'
                }`}
              >
                {step.label}
              </span>
            </li>
          ))}
          {running && (
            <li className="flex gap-3 py-1">
              <span className="pulse mt-[9px] h-px w-3 shrink-0 bg-teal-dark" aria-hidden="true" />
              <span className="text-table text-slate2-light">working</span>
            </li>
          )}
        </ol>
      )}
    </div>
  )
}

/** The figures under an answer: what it cost, what ran it, and the way into the trace. */
function RunFooter({ summary, recorded }) {
  const facts = [
    ['Latency', fmtMs(summary.latency_ms)],
    ['Tokens', `${fmtNum(summary.input_tokens)} / ${fmtNum(summary.output_tokens)}`],
    ['Cost', fmtUsd(summary.cost_usd)],
    summary.confidence == null ? null : ['Confidence', summary.confidence.toFixed(2)],
    summary.tools_called?.length ? ['Tools', summary.tools_called.join(', ')] : null,
    recorded ? ['Source', 'recorded'] : null,
  ].filter(Boolean)

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-1 text-meta">
      <StatusChip status={summary.status} />
      {facts.map(([label, value]) => (
        <span key={label} className="tabular">
          <span className="text-slate2-light">{label} </span>
          <span className="text-slate2">{value}</span>
        </span>
      ))}
      <Link to={`/audit/${summary.run_id}`} className="link text-meta">
        Full trace
      </Link>
    </div>
  )
}

/** One message in the thread — yours on the right, the agent's on the left. */
function Message({ message, onCitation, recorded }) {
  if (message.role === 'user') {
    return (
      <div className="item-in flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-navy px-4 py-3 font-serif text-quote text-paper sm:max-w-[78%]">
          {message.text}
        </p>
      </div>
    )
  }

  const status = message.summary?.status || message.result?.status
  const abstained = status === 'abstained'

  return (
    <div className="item-in flex gap-3">
      <AgentAvatar />
      <div className="min-w-0 flex-1 space-y-2.5">
        <Thinking
          steps={message.steps}
          running={message.running}
          latency={message.summary?.latency_ms}
        />

        {message.error && <p className="notice-error">{message.error}</p>}

        {message.answer && (
          <div
            className={`rounded-2xl rounded-bl-md border px-5 py-4 sm:max-w-[94%] ${
              abstained
                ? 'border-line border-l-[3px] border-l-slate2 bg-paper-tint'
                : 'border-line bg-paper-tint'
            }`}
          >
            {abstained && (
              <p className="mb-3 text-body font-medium text-slate2">
                The corpus does not support an answer to this question.
              </p>
            )}
            <Answer
              text={message.answer}
              citations={message.result?.citations || []}
              onCitation={onCitation}
              streaming={message.running}
            />
          </div>
        )}

        {message.summary && <RunFooter summary={message.summary} recorded={recorded} />}
      </div>
    </div>
  )
}

/** The example questions, folded away until asked for. Opens upward, over the thread. */
function ExampleQuestions({ onPick, disabled }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      {open && (
        <ul
          className="stagger absolute bottom-full left-0 z-20 mb-2 w-[min(660px,80vw)] overflow-hidden rounded-xl border border-line bg-paper shadow-lift"
          aria-label="Example questions"
        >
          {EXAMPLES.map((example) => (
            <li key={example} className="border-b border-line last:border-b-0">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  onPick(example)
                }}
                className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-200 ease-smooth hover:bg-paper-tint disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  className="mt-[10px] h-px w-4 shrink-0 bg-line-strong transition-all duration-300 ease-smooth group-hover:w-6 group-hover:bg-brand-red"
                  aria-hidden="true"
                />
                <span className="font-serif text-quote text-navy">{example}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="btn-quiet -ml-1"
      >
        <span
          className={`inline-block transition-transform duration-300 ease-smooth ${
            open ? 'rotate-45' : ''
          }`}
          aria-hidden="true"
        >
          +
        </span>
        {open ? 'Hide examples' : 'Examples'}
      </button>
    </div>
  )
}

/** The chat bar. Grows with what is typed, up to a ceiling, then scrolls internally. */
function Composer({ value, onChange, onSubmit, running }) {
  const field = useRef(null)

  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`
  }, [value])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex items-end gap-2 rounded-2xl border border-line bg-paper p-2 shadow-composer transition-all duration-300 ease-smooth focus-within:border-teal-dark/40 focus-within:shadow-lift"
    >
      <label htmlFor="question" className="sr-only">
        Message Monocle Lens
      </label>
      <textarea
        id="question"
        ref={field}
        rows={1}
        className="min-h-[40px] w-full resize-none bg-transparent px-3 py-2 font-serif text-read font-normal text-navy placeholder:font-sans placeholder:text-body placeholder:font-normal placeholder:text-slate2-light focus:outline-none"
        placeholder={PLACEHOLDER}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      <button
        type="submit"
        disabled={running || !value.trim()}
        aria-label={running ? 'Working' : 'Send'}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-redInk text-paper shadow-card transition-all duration-200 ease-smooth hover:bg-brand-redDeep hover:shadow-lift active:translate-y-px disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none disabled:hover:translate-y-0"
      >
        {running ? (
          <span className="pulse h-2 w-2 rounded-full bg-paper" aria-hidden="true" />
        ) : (
          <span className="text-[17px] leading-none" aria-hidden="true">
            ↑
          </span>
        )}
      </button>
    </form>
  )
}

export default function Ask({ meta }) {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [running, setRunning] = useState(false)
  const [citation, setCitation] = useState(null)
  const [conversationId, setConversationId] = useState(null)
  const abort = useRef(null)
  const scroller = useRef(null)

  useEffect(() => () => abort.current?.abort(), [])

  // Follow the thread as it is written. useLayoutEffect so the scroll lands in the
  // same frame as the paint, which is what stops streaming text from jittering.
  const tail = messages[messages.length - 1]
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, tail?.answer, tail?.steps?.length])

  const patch = useCallback((id, change) => {
    setMessages((list) =>
      list.map((m) =>
        m.id === id ? { ...m, ...(typeof change === 'function' ? change(m) : change) } : m,
      ),
    )
  }, [])

  const reset = () => {
    abort.current?.abort()
    setMessages([])
    setConversationId(null)
    setRunning(false)
    setCitation(null)
  }

  const ask = async (text) => {
    const q = (text ?? question).trim()
    if (!q || running) return

    // What the agent is allowed to remember: the tail of the thread as it stands
    // before this question. Abstentions and failures carry no answer, so they drop
    // out rather than going up as empty turns.
    const history = messages
      .map((m) =>
        m.role === 'user'
          ? { role: 'user', content: m.text }
          : m.answer
            ? { role: 'assistant', content: m.answer }
            : null,
      )
      .filter(Boolean)
      .slice(-MEMORY_MESSAGES)

    const id = `${Date.now()}`
    setMessages((list) => [
      ...list,
      { id: `${id}-q`, role: 'user', text: q },
      {
        id,
        role: 'agent',
        steps: [],
        answer: '',
        result: null,
        summary: null,
        error: null,
        running: true,
      },
    ])
    setQuestion('')
    setRunning(true)
    abort.current = new AbortController()

    const step = (s) => patch(id, (m) => ({ steps: [...m.steps, s] }))

    try {
      await streamChat(
        { question: q, history, conversation_id: conversationId },
        (event, data) => {
          if (event === 'run') setConversationId(data.conversation_id || null)
          else if (event === 'step') step({ label: `${data.name} — ${data.verdict}` })
          else if (event === 'plan')
            step({ label: `plan ${data.iteration}: ${data.intent}`, strong: true })
          else if (event === 'tool')
            step({
              label: `${data.tool} → ${data.ok ? `${data.evidence} passages` : data.error}`,
              failed: !data.ok,
            })
          else if (event === 'token') patch(id, (m) => ({ answer: m.answer + data.text }))
          else if (event === 'answer') patch(id, { result: data })
          else if (event === 'done') patch(id, { summary: data })
          else if (event === 'error') patch(id, { error: data.message })
        },
        abort.current.signal,
      )
    } catch {
      patch(id, {
        error:
          'The backend did not respond. Check that the API container is running, then ask again.',
      })
    } finally {
      patch(id, { running: false })
      setRunning(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader onReset={reset} canReset={messages.length > 0} />

      {/* The thread. Empty until someone asks something. */}
      <div ref={scroller} className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto flex w-full max-w-[780px] flex-col py-7 ${
            messages.length === 0 ? 'h-full justify-center' : 'space-y-6'
          }`}
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center pb-10 text-center">
              <AgentAvatar className="h-11 w-11" />
              <p className="mt-4 font-serif text-lead text-slate2">
                Ask a question about model risk or AI regulation.
              </p>
              <p className="mt-1.5 max-w-[46ch] text-body text-slate2-light">
                Answers come only from the corpus, with every claim traceable. Follow-up
                questions keep the thread.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                onCitation={setCitation}
                recorded={!!meta?.demo_mode}
              />
            ))
          )}
        </div>
      </div>

      {/* The chat bar holds the foot of the frame. */}
      <div className="shrink-0 border-t border-line bg-paper pb-5 pt-3">
        <div className="mx-auto w-full max-w-[780px]">
          <Composer
            value={question}
            onChange={setQuestion}
            onSubmit={() => ask()}
            running={running}
          />
          <div className="mt-2 flex items-center justify-between gap-4">
            <ExampleQuestions onPick={ask} disabled={running} />
            <p className="text-meta text-slate2-light">
              Remembers the last {MEMORY_MESSAGES} messages
            </p>
          </div>
        </div>
      </div>

      {citation && <EvidenceDrawer citation={citation} onClose={() => setCitation(null)} />}
    </div>
  )
}
