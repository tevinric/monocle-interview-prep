import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SPAN_COLOURS } from '../components/Waterfall'

const SECTIONS = [
  ['what-it-does', 'What Lens does'],
  ['screens', 'Where to find things'],
  ['pipeline', 'How a question becomes an answer'],
  ['grounding', 'How it stays grounded'],
  ['accuracy', 'How accuracy is measured'],
  ['reproducing', 'Reproducing a past answer'],
  ['trace', 'Reading a trace'],
  ['limits', 'What it will not do'],
]

// Acceptance criteria as they are written in evals/questions.yaml. They live with
// the question set so a run reports pass or fail, not a number to interpret.
const THRESHOLDS = [
  ['Citation precision', '0.85', 'Each citation resolves to a real passage and supports the sentence carrying it. Judged by a separate, cheaper model against a strict rubric.'],
  ['Groundedness', '0.80', 'The proportion of sentences in an answer with supporting evidence in the retrieved passages.'],
  ['Retrieval hit rate @8', '0.80', 'The document a question should draw on appears in the top eight passages retrieved.'],
  ['Abstention correctness', '0.80', 'On questions the corpus deliberately cannot answer, the agent abstains instead of improvising.'],
  ['Latency, 95th percentile', '45 s', 'A ceiling, not a target.'],
  ['Cost per question', '$0.10', 'A ceiling, not a target.'],
]

const SPAN_KINDS = [
  ['agent', 'The turn itself, and the planning loop inside it.'],
  ['llm', 'A model call. Records the rendered prompt, its version hash, the raw response, the finish reason and the token split — which is what makes the run reproducible later.'],
  ['retrieval', 'A search. Records every candidate considered, with rank, score, retriever and whether it reached the answer.'],
  ['tool', 'A tool call. Records the arguments and the result verbatim, including failures.'],
  ['guardrail', 'A check. Records the verdict, and redaction types and counts — never the values themselves.'],
]

// The three readings of one trace offered on a trace page, in the order the switch
// presents them.
const TRACE_VIEWS = [
  ['Flow', 'The run as a workflow: every recorded step, left to right, with an arrow where one step fed the next. Tools the planner dispatched together are stacked in one column because that is how they ran, and each pass of the loop sits on its own band. Overview folds a tool\u2019s retrieval back into the tool box; Every span draws all of them.'],
  ['Knowledge', 'What the run reached in the corpus. Documents on the inner ring, the passages retrieved from each on the outer one, and the handful that were quoted marked and linked. The distance between considered and quoted is the point of the picture.'],
  ['Timeline', 'The same steps against the clock: each bar starts where that step started and is as wide as it took. This is the one to read when the question is where the time went.'],
]

const STEPS = [
  ['Input check', 'The question is scanned for personal information before it reaches a model. The verdict is recorded whether or not anything is found.'],
  ['Plan', 'A model call decides what the question is asking, which frameworks are in scope, and which tools to call. The plan is structured output, not prose, so it is inspectable.'],
  ['Retrieve and call tools', 'Up to three iterations. Hybrid search runs in PostgreSQL; four further tools fetch full sections, compare frameworks, classify EU AI Act risk and list obligations by role. If the evidence is thin and iterations remain, the query is refined and the loop runs again.'],
  ['Synthesise', 'A second model call writes the answer against the retrieved passages only, returning the answer, its citations, a confidence score and any claims it could not support.'],
  ['Groundedness check', 'Every citation must resolve to a real passage. Claims that nothing supports are stripped rather than published.'],
  ['Answer, or abstain', 'If confidence falls below the configured threshold, or nothing survives with a citation, the agent abstains and says what it searched.'],
]

const GROUNDING = [
  [
    'A closed corpus',
    'The agent can read six public regulatory documents and nothing else: PRA SS1/23, SR 11-7, the EU AI Act, POPIA, ISO/IEC 42001 and BCBS 239. There is no web search and no general knowledge fallback. Each document is recorded with its publisher, version, retrieval date and SHA-256, so the exact bytes behind an answer are identifiable.',
  ],
  [
    'Retrieval you can inspect',
    'Search is hybrid: a dense vector query and a keyword query each return twenty candidates, combined by reciprocal rank fusion, and the top eight are passed on. Every candidate is persisted with its rank, score and retriever — including the ones the answer did not use. What the agent considered and discarded is part of the record.',
  ],
  [
    'Citations that resolve to characters',
    'A citation is not a document name. It is a character range in a specific section of a specific document. Passages are chunked at roughly 800 tokens with 120 of overlap and never cross a top-level section boundary, so a quote keeps its context. Selecting a citation opens the source text with the quoted span highlighted where it actually sits.',
  ],
  [
    'Abstention as a normal outcome',
    'An agent that always answers is not trustworthy, it is only confident. When the corpus cannot support an answer, Lens says so and lists what it searched. That path is tested: the evaluation set includes questions it is meant to refuse.',
  ],
]

/** Marks the section currently in view in the contents list. */
function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
    )
    ids.forEach((id) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [ids])
  return active
}

function Section({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-10 first:border-t-0 first:pt-0">
      <h2 className="brand-rule text-headline font-semibold tracking-[-0.02em] text-navy">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  )
}

export default function Help() {
  const ids = useRef(SECTIONS.map(([id]) => id)).current
  const active = useActiveSection(ids)

  return (
    <div className="mx-auto max-w-[1120px] pb-20">
      {/* A navy structural block, the one place on the page that carries weight. */}
      <header className="relative overflow-hidden rounded-xl bg-navy px-7 py-10 text-paper shadow-lift sm:px-10 sm:py-12">
        {/* The Monocle diagonal, at the scale of the block it sits in. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-10 h-[150%] w-[300px] -skew-x-[18deg] opacity-70"
          style={{
            background:
              'linear-gradient(to bottom, rgba(232,43,43,0.30), rgba(232,43,43,0.08) 55%, transparent 85%)',
          }}
        />
        <div className="relative">
        <p className="eyebrow-dark">Using Lens</p>
        <h1 className="mt-4 max-w-[24ch] font-serif text-[28px] font-semibold leading-[1.2] tracking-[-0.01em] sm:text-display">
          An answer is only as good as the evidence you can check.
        </h1>
        <p className="mt-5 max-w-[70ch] font-serif text-lead font-normal leading-[30px] text-teal">
          Lens answers regulatory questions from a fixed set of public documents, cites the exact passage
          behind every claim, and records what it did well enough that someone else can audit it.
        </p>
        </div>
      </header>

      <div className="mt-12 gap-x-16 lg:grid lg:grid-cols-[minmax(0,1fr)_216px]">
        <div className="min-w-0 space-y-12">
          <Section id="what-it-does" title="What Lens does">
            <div className="prose-read max-w-[70ch] space-y-5 text-slate2">
              <p>
                Ask a question about model risk management or AI regulation and Lens retrieves the relevant
                passages from six public documents, writes an answer from those passages alone, and attaches
                a citation to each claim. Every citation opens the source text with the quoted words
                highlighted in place.
              </p>
              <p>
                Behind each answer is a complete trace: the prompt that was sent and its version, every
                passage considered, every tool called with its arguments and result, the guardrail verdicts,
                and the tokens, latency and cost. The same run can be replayed against the current prompt
                version to show what changed.
              </p>
            </div>
          </Section>

          <Section id="screens" title="Where to find things">
            <dl className="mt-1">
              {[
                ['Ask', '/', 'Put a question in, watch the agent work, read the answer with its citations.'],
                ['Audit', '/audit', 'Every turn ever run, filterable by status, tool, framework and date. Open one for its full trace.'],
                ['Corpus', '/corpus', 'The six documents, with publisher, version, retrieval date, checksum and passage count.'],
                ['Evaluation', '/evals', 'The last scored run of the question set, against thresholds that ship with it.'],
              ].map(([name, to, what]) => (
                <div key={name} className="flex flex-col gap-1 border-b border-line py-3.5 sm:flex-row sm:gap-6">
                  <dt className="w-24 shrink-0">
                    <Link to={to} className="link text-body">
                      {name}
                    </Link>
                  </dt>
                  <dd className="max-w-[72ch] font-serif text-quote text-slate2">{what}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="pipeline" title="How a question becomes an answer">
            <p className="max-w-[76ch] font-serif text-quote text-slate2">
              Six stages, in order, every one of them a recorded span. Nothing reaches a model or the
              database without leaving a trace, and spans persist even when a stage fails.
            </p>
            <ol className="mt-7">
              {STEPS.map(([name, detail], i) => (
                <li key={name} className="relative flex gap-5 pb-7 last:pb-0">
                  {/* The rule connecting the stages; it stops at the last one. */}
                  {i < STEPS.length - 1 && (
                    <span className="absolute left-[15px] top-8 bottom-1 w-px bg-line" aria-hidden="true" />
                  )}
                  <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-paper text-meta font-medium tabular text-teal-dark">
                    {i + 1}
                  </span>
                  <div className="pt-1">
                    <h3 className="text-body font-medium text-navy">{name}</h3>
                    <p className="mt-1.5 max-w-[68ch] font-serif text-quote text-slate2">{detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="grounding" title="How it stays grounded">
            <p className="max-w-[76ch] font-serif text-quote text-slate2">
              Groundedness is not a prompt instruction here. It is four structural constraints, each of
              which leaves evidence.
            </p>
            <div className="mt-7 space-y-8">
              {GROUNDING.map(([title, body]) => (
                <div key={title} className="border-l-2 border-teal pl-5">
                  <h3 className="text-body font-medium text-navy">{title}</h3>
                  <p className="mt-2 max-w-[72ch] font-serif text-quote text-slate2">{body}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 max-w-[76ch] rounded-md bg-teal-tint px-5 py-4 font-serif text-quote text-navy">
              The practical test: pick any sentence in an answer, select its citation, and read the
              surrounding section. If the sentence is not supported by what you see, that is a defect you
              can file — not an opinion you have to argue.
            </p>
          </Section>

          <Section id="accuracy" title="How accuracy is measured">
            <p className="max-w-[76ch] font-serif text-quote text-slate2">
              A question set of roughly two dozen questions is scored on six measures. Start a run with{' '}
              <strong className="font-medium text-navy">Run evaluation</strong> on the Evaluation screen, or
              with <span className="font-mono text-navy">make eval</span> on the command line — both call the
              same code, and the screen reports progress question by question while it works. Thresholds live
              in the same file as the questions, so a run reports pass or fail rather than a number someone
              has to interpret, and every scored question links to the trace it produced.
            </p>
            <div className="mt-7 overflow-x-auto">
              <table className="table-base min-w-[620px]">
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col" className="num">Threshold</th>
                    <th scope="col">What it checks</th>
                  </tr>
                </thead>
                <tbody>
                  {THRESHOLDS.map(([name, value, what]) => (
                    <tr key={name}>
                      <td className="whitespace-nowrap font-normal text-navy">{name}</td>
                      <td className="num font-medium">{value}</td>
                      <td className="text-slate2">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-6 font-serif text-quote text-slate2">
              <Link to="/evals" className="link">
                See the last run
              </Link>
              .
            </p>
          </Section>

          <Section id="reproducing" title="Reproducing a past answer">
            <p className="max-w-[76ch] font-serif text-quote text-slate2">
              A trace screen offers two different things, and the difference matters. Language models are
              not deterministic: the same question asked twice will not return the same words, so
              reproducibility cannot rest on asking again.
            </p>
            <div className="mt-7 space-y-8">
              <div className="border-l-2 border-teal pl-5">
                <h3 className="text-body font-medium text-navy">Reproduce this run</h3>
                <p className="mt-2 max-w-[72ch] font-serif text-quote text-slate2">
                  Re-executes the pipeline against the model responses this run recorded in its own trace.
                  Retrieval, every tool, the guardrails and citation verification all run again for real —
                  only the sampled step is served from the record. The answer must come back identical, and
                  the screen says whether it did. A failure here means the trace was not a complete account
                  of how the answer was reached, which is a defect in the audit trail itself.
                </p>
              </div>
              <div className="border-l-2 border-line-strong pl-5">
                <h3 className="text-body font-medium text-navy">Re-run against current prompts</h3>
                <p className="mt-2 max-w-[72ch] font-serif text-quote text-slate2">
                  Asks the question again, now, against whatever prompts and configuration are live. The
                  answer may legitimately differ, and that difference is the point: the two answers are
                  shown side by side with citations, cost and latency compared. This is change control
                  demonstrated on a real turn rather than asserted in a document.
                </p>
              </div>
            </div>
            <p className="mt-8 max-w-[76ch] rounded-md bg-teal-tint px-5 py-4 font-serif text-quote text-navy">
              Put plainly: reproduction proves the record is complete, and a re-run shows what moved since.
              Asking a model the same question twice proves neither.
            </p>
          </Section>

          <Section id="trace" title="Reading a trace">
            <p className="max-w-[76ch] font-serif text-quote text-slate2">
              One trace, read three ways. They share a selection: choose a step in any of them and the
              panel beneath shows exactly what that step sent and received.
            </p>
            <dl className="mt-6">
              {TRACE_VIEWS.map(([name, what]) => (
                <div key={name} className="flex gap-4 border-b border-line py-3.5">
                  <dt className="w-24 shrink-0 text-body font-medium text-navy">{name}</dt>
                  <dd className="max-w-[72ch] font-serif text-quote text-slate2">{what}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-7 max-w-[76ch] font-serif text-quote text-slate2">
              On the timeline, colour marks the kind of work. The flow map uses the same colours on the
              edge of each box.
            </p>
            <dl className="mt-7">
              {SPAN_KINDS.map(([kind, what]) => (
                <div key={kind} className="flex gap-4 border-b border-line py-3.5">
                  <dt className="flex w-24 shrink-0 items-baseline gap-2.5 text-body text-navy">
                    <span
                      className="mt-[7px] h-[3px] w-4 shrink-0 rounded-sm"
                      style={{ background: SPAN_COLOURS[kind] }}
                      aria-hidden="true"
                    />
                    {kind}
                  </dt>
                  <dd className="max-w-[72ch] font-serif text-quote text-slate2">{what}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 max-w-[76ch] font-serif text-quote text-slate2">
              A step that failed is marked in red and still carries its record — a tool that errored shows
              the arguments that produced the error. Export audit pack downloads the whole trace as JSON.
            </p>
          </Section>

          <Section id="limits" title="What it will not do">
            <ul className="space-y-3.5">
              {[
                'Answer from anything outside the six documents, including general knowledge about regulation it was trained on.',
                'Give legal advice. It reports what the documents say and where they say it; the judgement remains yours.',
                'Read a document that failed to download. Those appear on the Corpus screen as unavailable rather than being quietly dropped.',
                'Hide a failure. Errors, abstentions and stripped claims are recorded and visible in the audit history.',
              ].map((line) => (
                <li key={line} className="flex max-w-[76ch] gap-3.5 font-serif text-quote text-slate2">
                  <span className="mt-[11px] h-px w-3.5 shrink-0 bg-line-strong" aria-hidden="true" />
                  {line}
                </li>
              ))}
            </ul>
          </Section>
        </div>

        {/* Contents, tracking the section in view. */}
        <nav aria-label="On this page" className="mt-12 hidden lg:mt-0 lg:block">
          <div className="sticky top-10">
            <p className="field-label">On this page</p>
            <ul className="mt-3 border-l border-line">
              {SECTIONS.map(([id, label]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    aria-current={active === id ? 'true' : undefined}
                    className={`-ml-px block border-l-2 py-1.5 pl-4 text-meta leading-4 transition-colors duration-200 ease-smooth ${
                      active === id
                        ? 'border-teal-dark font-medium text-navy'
                        : 'border-transparent text-slate2 hover:text-navy'
                    }`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </div>
  )
}
