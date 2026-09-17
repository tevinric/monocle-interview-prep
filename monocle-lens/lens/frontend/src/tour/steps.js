/**
 * The guided tour, as a script.
 *
 * One entry per stop. The tour engine (TourProvider) navigates to `route`, waits for the
 * element carrying `data-tour="<anchor>"` to exist, scrolls it into view and draws the
 * card beside it. An anchor that never appears — a screen with no data yet, a rail that
 * is hidden at this width — is not an error: the step is shown centred instead, so the
 * narrative never breaks on a stack that has just been started.
 *
 * KEEP IT SHORT. A stop is one sentence of what the thing is, and one line of why it
 * matters to someone carrying model risk in a bank. Anything longer belongs in Help: the
 * tour exists to show how much is here in the two minutes somebody will actually give it,
 * and a wall of text is how that time gets spent instead on closing the card.
 *
 *   id        stable key, also used for the progress announcement
 *   chapter   shown above the title, so a reader knows where they are in the whole
 *   route     the path this stop is read on
 *   anchor    data-tour value to spotlight; omitted for a centred stop
 *   body      one short paragraph — two only where the stop carries the whole chapter
 *   note      the regulated-environment point, in a dozen words, set apart in the card
 *   needsRun  true for stops that only exist once there is a trace to open
 *   traceView switches the trace diagram before the card is drawn
 *   placement preferred side; the engine overrides it when it would leave the viewport
 */

const SCRIPT = [
  {
    id: 'welcome',
    chapter: 'Welcome',
    route: '/',
    title: 'This is Monocle Lens',
    body: [
      'A regulatory research agent over six public frameworks — SS1/23, SR 11-7, the EU AI Act, POPIA, ISO/IEC 42001 and BCBS 239. Built by Tevin Richard for Monocle Tech.',
    ],
    note: 'Built to show what auditable AI looks like where it is actually regulated.',
  },

  {
    id: 'ask-agent',
    chapter: 'Asking',
    route: '/',
    anchor: 'chat-header',
    placement: 'bottom',
    title: 'A closed corpus, not a chatbot',
    body: [
      'No web search, no general knowledge. It answers from six documents, or it abstains and says what it searched.',
    ],
    note: 'A refusal you can trust beats an answer you cannot.',
  },
  {
    id: 'ask-composer',
    chapter: 'Asking',
    route: '/',
    anchor: 'composer',
    placement: 'top',
    title: 'Ask it what a second line would ask',
    body: [
      'Plain language, and follow-ups keep the thread. Every answer lands with its latency, tokens, cost, confidence and a link into the full trace.',
    ],
    note: 'Cost and latency on every turn, not a surprise at month end.',
  },

  {
    id: 'corpus-doc',
    chapter: 'The corpus',
    route: '/corpus',
    anchor: 'corpus-doc',
    placement: 'bottom',
    title: 'Every source pinned to its bytes',
    body: [
      'Publisher, version, retrieval date and SHA-256 for each document — and a source that fails to download is shown as unavailable, never quietly dropped.',
    ],
    note: 'Which edition of a regulation produced an answer, provable in nine months.',
  },

  {
    id: 'audit-intro',
    chapter: 'The audit trail',
    route: '/audit',
    anchor: 'audit-header',
    placement: 'bottom',
    title: 'Every run, kept',
    body: [
      'Every turn ever asked — answered, abstained or failed — with its complete execution record.',
    ],
    note: 'The audit trail is not logging bolted on afterwards. It is the product.',
  },
  {
    id: 'audit-filters',
    chapter: 'The audit trail',
    route: '/audit',
    anchor: 'audit-filters',
    placement: 'bottom',
    title: 'Interrogate the history',
    body: [
      'Filter by status, by tool, by the framework cited or by date, and search the text of every question ever asked.',
    ],
    note: '“Every answer citing the EU AI Act, and every abstention” — four clicks.',
  },

  {
    id: 'run-meta',
    chapter: 'Inside a trace',
    route: '/audit/:runId',
    needsRun: true,
    anchor: 'run-meta',
    placement: 'bottom',
    title: 'One turn, reconstructed',
    body: [
      'The model that ran it, the prompt bundle and configuration hashes, confidence, tokens, cost and trace id — on one line.',
    ],
    note: 'Change a prompt and the hash changes. Version control for model behaviour.',
  },
  {
    id: 'trace-flow',
    chapter: 'Inside a trace',
    route: '/audit/:runId',
    needsRun: true,
    anchor: 'trace-canvas',
    traceView: 'flow',
    placement: 'top',
    title: 'The run as a workflow',
    body: [
      'Every recorded step, and what fed what. Select one for the exact prompt sent and the raw response — or, for a tool, its arguments and result verbatim, failures included.',
    ],
    note: 'Nothing reaches a model or the database without leaving a span.',
  },
  {
    id: 'trace-knowledge',
    chapter: 'Inside a trace',
    route: '/audit/:runId',
    needsRun: true,
    anchor: 'trace-canvas',
    traceView: 'knowledge',
    placement: 'top',
    title: 'What it read, and what it used',
    body: [
      'Documents on the inner ring, the passages retrieved on the outer one, and the few that reached the answer marked and linked.',
    ],
    note: 'What the agent considered and discarded is part of the record.',
  },
  {
    id: 'trace-timeline',
    chapter: 'Inside a trace',
    route: '/audit/:runId',
    needsRun: true,
    anchor: 'trace-canvas',
    traceView: 'timeline',
    placement: 'top',
    title: 'Where the time went',
    body: [
      'The same steps against the clock, each bar as wide as that step took.',
    ],
    note: 'Service-level questions answered from the trace rather than from memory.',
  },
  {
    id: 'run-guardrails',
    chapter: 'Inside a trace',
    route: '/audit/:runId',
    needsRun: true,
    anchor: 'run-guardrails',
    placement: 'top',
    title: 'What the answer had to pass',
    body: [
      'The question is screened for personal information before it reaches a model. Afterwards every citation must resolve to a real passage, or the claim is stripped rather than published.',
    ],
    note: 'Redaction types and counts are recorded — never the values themselves.',
  },
  {
    id: 'run-actions',
    chapter: 'Inside a trace',
    route: '/audit/:runId',
    needsRun: true,
    anchor: 'run-actions',
    placement: 'bottom',
    title: 'The artefact a validator asks for',
    body: [
      'Export the whole record as one JSON pack. Or reproduce the run against its recorded model responses — the answer must come out identical, and the screen says whether it did.',
    ],
    note: 'Change control demonstrated, rather than described in a policy.',
  },

  {
    id: 'evals',
    chapter: 'Evaluation',
    route: '/evals',
    anchor: 'evals-metrics',
    placement: 'top',
    title: 'Scored against thresholds, not impressions',
    body: [
      'Citation precision, groundedness, retrieval hit rate, abstention correctness, latency and cost — each one pass or fail, each row linking back to its trace.',
    ],
    note: 'Abstention is scored too: always answering is not trustworthy, only confident.',
  },

  {
    id: 'finish',
    chapter: 'Reference',
    route: '/help',
    anchor: 'tour-launch',
    placement: 'right',
    title: 'That is the tour',
    body: [
      'Help has the detail behind every stage. The tour lives here whenever you want it again — have a look around.',
    ],
  },
]

/**
 * The script for this session.
 *
 * Without a run to open, the six stops inside a trace have nothing to point at, so they
 * are dropped rather than shown as empty rooms. A fresh stack with no history still gets
 * a coherent tour, and `make seed` or one question puts the chapter back.
 */
export function buildSteps({ runId } = {}) {
  return SCRIPT.filter((step) => !step.needsRun || runId).map((step) => ({
    ...step,
    route: runId ? step.route.replace(':runId', runId) : step.route,
  }))
}

export default SCRIPT
