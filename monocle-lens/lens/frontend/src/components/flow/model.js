/**
 * The flow model — one run's spans, arranged as a left-to-right workflow graph.
 *
 * The waterfall answers "when did each step run, and for how long". This answers the
 * other question a reader has: "what did the agent actually do, and in what order did
 * one step feed the next". Both read the same spans; neither invents a step.
 *
 * Layout is derived, not authored:
 *   · a column is a stage — a span sits one column right of the step that produced it;
 *   · a row is concurrency — siblings whose recorded intervals overlap (the tools the
 *     planner dispatched together) are stacked in one column rather than strung out;
 *   · an `agent.*` span with children is a container, drawn as a frame around the work
 *     it enclosed rather than as a box of its own.
 *
 * Nothing here reads a clock or a layout engine: the same trace always draws the same
 * picture, which is the point of putting it next to an audit trail.
 */
import { SPAN_COLOURS } from '../Waterfall'
import { fmtMs, fmtNum, fmtUsd, sectionRef } from '../MetaStrip'

// Geometry. Exported so the canvas can size its viewport from the same numbers.
export const NODE_W = 206
export const NODE_H = 82
export const COL_GAP = 68
export const ROW_GAP = 22
export const PAD = 52
export const GROUP_PAD = 22
export const GROUP_LABEL = 26

export const FLOW_COLOURS = { ...SPAN_COLOURS, start: '#22788A', end: '#112232' }

// What each kind of box is called in the legend, in the words the Help page uses.
export const FLOW_LEGEND = [
  ['start', 'the question as it reached the agent, after PII screening'],
  ['llm', 'a call to the model — planning, or drafting the answer'],
  ['tool', 'a tool the planner chose, with the arguments it chose'],
  ['retrieval', 'a search over the corpus, and every candidate it ranked'],
  ['guardrail', 'a check the answer had to pass before it was released'],
  ['end', 'what left the system, and at what confidence'],
]

const TOOL_TITLES = {
  search_corpus: 'Search the corpus',
  fetch_section: 'Fetch a section',
  compare_frameworks: 'Compare frameworks',
  classify_ai_act_risk: 'EU AI Act risk tier',
  list_obligations: 'List obligations',
}

const LLM_TITLES = {
  'llm.plan': 'Plan the next step',
  'llm.synthesise': 'Draft the answer',
  'llm.embed': 'Embed the query',
}

const GUARDRAIL_TITLES = {
  'guardrail.input_pii': 'Screen the question',
  'guardrail.groundedness': 'Verify every citation',
  'guardrail.abstention': 'Answer, or abstain',
}

const RETRIEVAL_TITLES = {
  'retrieval.hybrid': 'Hybrid search',
  'retrieval.section': 'Section lookup',
  'retrieval.article_lookup': 'Article lookup',
}

const ms = (v) => (v == null ? null : new Date(v).getTime())
const clip = (text, n = 68) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/** The short name of the work a span did, plus the one or two figures worth carrying
 *  on the box itself. Everything else stays in the span detail below the canvas. */
function describe(span, verdict) {
  const attrs = span.attributes_json || {}
  const out = span.output_json || {}
  const input = span.input_json || {}
  const badges = []
  let title = span.name
  let subtitle = ''

  if (span.type === 'tool') {
    const tool = attrs.tool_name || span.name.replace(/^tool\./, '')
    title = TOOL_TITLES[tool] || tool.replace(/_/g, ' ')
    subtitle = clip(
      input.query ||
        input.topic ||
        input.section_path ||
        input.system_description ||
        [input.framework, input.role].filter(Boolean).join(' · '),
    )
    if (Array.isArray(input.frameworks) && input.frameworks.length) {
      badges.push(input.frameworks.join(', '))
    }
    if (out.evidence != null) badges.push(`${out.evidence} evidence`)
  } else if (span.type === 'retrieval') {
    const suffix = span.name.split('.')[2]
    title = RETRIEVAL_TITLES[span.name.split('.').slice(0, 2).join('.')] || 'Retrieval'
    if (suffix) title += ` · ${suffix}`
    subtitle = clip(input.query || (out.sections || []).map(sectionRef).join(', '))
    const kept = out.n_fused ?? out.n
    if (kept != null) badges.push(`${kept} passages`)
    if (out.top_score != null) badges.push(`top ${Number(out.top_score).toFixed(3)}`)
  } else if (span.type === 'llm') {
    title = LLM_TITLES[span.name] || span.name
    subtitle = attrs.model || ''
    if (attrs.input_tokens != null) {
      badges.push(`${fmtNum(attrs.input_tokens)} → ${fmtNum(attrs.output_tokens)} tokens`)
    }
    if (attrs.cost_usd != null) badges.push(fmtUsd(attrs.cost_usd))
  } else if (span.type === 'guardrail') {
    title = GUARDRAIL_TITLES[span.name] || span.name.replace('guardrail.', '')
    subtitle = clip(out.reasons?.[0] || (verdict ? `verdict: ${verdict}` : ''))
    if (verdict) badges.push(verdict)
  } else if (span.type === 'agent') {
    title = span.name
  }

  return { title, subtitle, badges }
}

/** `agent.iteration.2` reads as "Iteration 2" on the frame around it. */
function containerLabel(span) {
  const n = span.name.match(/(\d+)$/)
  const out = span.output_json || {}
  return {
    label: n ? `Iteration ${n[1]}` : span.name,
    note: clip(out.intent || '', 74),
    hint: out.evidence_sufficient === true ? 'evidence judged sufficient' : '',
  }
}

/** Siblings that ran at the same time belong in the same column. The planner
 *  dispatches its tools through a thread pool, and the trace records the overlap. */
function splitWaves(spans) {
  const waves = []
  let current = null
  spans.forEach((span) => {
    const start = ms(span.started_at)
    const end = ms(span.ended_at) ?? start
    if (current && start < current.end && end > current.start) {
      current.spans.push(span)
      current.start = Math.min(current.start, start)
      current.end = Math.max(current.end, end)
    } else {
      current = { spans: [span], start, end }
      waves.push(current)
    }
  })
  return waves.map((w) => w.spans)
}

/**
 * Build the graph.
 *
 * `detail` is 'overview' or 'full'. Overview folds the retrieval a tool performed —
 * and the embedding call inside it — back into the tool box, as counts on its face:
 * the same trace, read at the altitude of "what did the agent do". Nothing is dropped;
 * 'full' draws every recorded span, and the folded counts say how many are hidden.
 */
export function buildFlow(run, spans, guardrailEvents = [], detail = 'overview') {
  const verdicts = {}
  guardrailEvents.forEach((e) => {
    if (e.span_id) verdicts[String(e.span_id)] = e.verdict
  })

  const byParent = new Map()
  spans.forEach((span) => {
    const key = span.parent_span_id ? String(span.parent_span_id) : '__root__'
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(span)
  })
  byParent.forEach((list) => list.sort((a, b) => a.sequence - b.sequence))

  const childrenOf = (span) => byParent.get(String(span.id)) || []
  const isContainer = (span) => span.type === 'agent' && childrenOf(span).length > 0
  const folds = (span) => detail === 'overview' && span.type === 'tool'

  const roots = byParent.get('__root__') || []
  // The run's own span frames everything; it is drawn as the question and the answer
  // rather than as a box wrapped around the whole canvas.
  const root = roots.find((s) => s.type === 'agent') || roots[0]
  const spine = root ? childrenOf(root) : roots

  const nodes = []
  const edges = []
  const groups = []
  const seen = new Set()

  const countFolded = (span) => {
    let n = 0
    childrenOf(span).forEach((child) => {
      n += 1 + countFolded(child)
    })
    return n
  }

  const foldedBadges = (span) => {
    const badges = []
    let passages = 0
    let embeds = 0
    const walk = (s) =>
      childrenOf(s).forEach((child) => {
        const out = child.output_json || {}
        if (child.type === 'retrieval') passages += out.n_fused ?? out.n ?? 0
        if (child.type === 'llm') embeds += 1
        walk(child)
      })
    walk(span)
    if (passages) badges.push(`${passages} passages ranked`)
    if (embeds) badges.push(`${embeds} embedding${embeds === 1 ? '' : 's'}`)
    return badges
  }

  const addNode = (span, col, row) => {
    const described = describe(span, verdicts[String(span.id)])
    const hidden = folds(span) ? countFolded(span) : 0
    const node = {
      id: String(span.id),
      spanId: String(span.id),
      kind: span.type,
      col,
      row,
      status: span.status,
      duration: span.duration_ms,
      durationLabel: fmtMs(span.duration_ms),
      hidden,
      ...described,
      badges: [...described.badges, ...(hidden ? foldedBadges(span) : [])],
    }
    nodes.push(node)
    return node
  }

  const link = (from, to, kind = 'flow') =>
    from.forEach((a) =>
      to.forEach((b) => {
        const id = `${a.id}->${b.id}`
        if (a.id !== b.id && !seen.has(id)) {
          seen.add(id)
          edges.push({ id, from: a.id, to: b.id, kind })
        }
      }),
    )

  // Place a list of siblings from `col`/`row`, returning where the level starts, where
  // it ends, and how much of the grid it consumed.
  //
  // `band` applies to the run's own spine: when the agent looped, each iteration is
  // dropped onto a fresh row band rather than strung further to the right. A loop is
  // what actually happened, and drawn this way it looks like one — and the picture
  // keeps a shape a screen can hold.
  const placeLevel = (siblings, col, row, band = false) => {
    const waves = splitWaves(siblings)
    const banding = band && waves.filter((w) => w.some(isContainer)).length >= 2
    let bandCol = null
    let previousWasContainer = false
    let c = col
    let baseRow = row
    let maxCol = col
    let maxRow = row
    let first = null
    let previous = null

    waves.forEach((wave) => {
      const containerWave = wave.some(isContainer)
      if (banding) {
        if (containerWave && bandCol === null) {
          // The first pass of the loop carries on from whatever preceded it; every band
          // after it returns to the left, where the level itself began.
          bandCol = col
        } else if (containerWave || previousWasContainer) {
          baseRow = maxRow + 2
          c = bandCol
        }
      }
      previousWasContainer = containerWave

      let r = baseRow
      let waveCol = c
      const entries = []
      const exits = []
      wave.forEach((span) => {
        const placed = placeSpan(span, c, r)
        entries.push(...placed.entries)
        exits.push(...placed.exits)
        r = placed.maxRow + 1
        waveCol = Math.max(waveCol, placed.maxCol)
      })
      maxRow = Math.max(maxRow, r - 1)
      maxCol = Math.max(maxCol, waveCol)
      if (previous) link(previous.exits, entries)
      if (!first) first = { entries }
      previous = { entries, exits }
      c = waveCol + 1
    })

    return {
      entries: first?.entries || [],
      exits: previous?.exits || [],
      maxCol,
      maxRow,
    }
  }

  function placeSpan(span, col, row) {
    if (isContainer(span)) {
      const inner = placeLevel(childrenOf(span), col, row)
      groups.push({
        id: String(span.id),
        spanId: String(span.id),
        col0: col,
        col1: inner.maxCol,
        row0: row,
        row1: inner.maxRow,
        ...containerLabel(span),
      })
      return inner
    }
    const node = addNode(span, col, row)
    const kids = folds(span) ? [] : childrenOf(span)
    if (kids.length === 0) return { entries: [node], exits: [node], maxCol: col, maxRow: row }
    const inner = placeLevel(kids, col + 1, row)
    link([node], inner.entries, 'branch')
    return {
      entries: [node],
      exits: inner.exits,
      maxCol: inner.maxCol,
      maxRow: Math.max(row, inner.maxRow),
    }
  }

  const body = placeLevel(spine, 1, 0, true)

  // The two boxes that are not spans: what went in, and what came out. The answer sits
  // at the end of the last band, which is where the run actually finished.
  const start = {
    id: 'start',
    spanId: root ? String(root.id) : null,
    kind: 'start',
    col: 0,
    row: 0,
    status: 'ok',
    title: 'Question',
    subtitle: clip(run.user_message, 72),
    badges: [run.llm_source === 'recording' ? 'replayed responses' : 'live model'],
    hidden: 0,
    durationLabel: fmtMs(run.latency_ms),
  }
  const endTitle =
    run.status === 'ok' ? 'Answer' : run.status === 'abstained' ? 'Abstained' : 'Failed'
  const end = {
    id: 'end',
    spanId: root ? String(root.id) : null,
    kind: 'end',
    col: Math.max(...body.exits.map((n) => n.col)) + 1,
    row: Math.min(...body.exits.map((n) => n.row)),
    status: run.status === 'ok' ? 'ok' : run.status === 'error' ? 'error' : 'abstained',
    title: endTitle,
    subtitle: clip(run.abstain_reason || run.error || run.final_answer, 72),
    badges: [
      run.confidence == null ? null : `confidence ${Number(run.confidence).toFixed(2)}`,
      fmtUsd(run.cost_usd),
    ].filter(Boolean),
    hidden: 0,
    durationLabel: fmtMs(run.latency_ms),
  }
  nodes.unshift(start)
  nodes.push(end)
  link([start], body.entries)
  link(body.exits, [end])

  const x = (col) => PAD + col * (NODE_W + COL_GAP)
  const y = (row) => PAD + row * (NODE_H + ROW_GAP)

  nodes.forEach((node) => {
    node.x = x(node.col)
    node.y = y(node.row)
  })
  groups.forEach((group) => {
    group.x = x(group.col0) - GROUP_PAD
    group.y = y(group.row0) - GROUP_PAD - GROUP_LABEL
    group.w = x(group.col1) + NODE_W + GROUP_PAD - group.x
    group.h = y(group.row1) + NODE_H + GROUP_PAD - group.y
  })

  const width = Math.max(
    ...nodes.map((n) => n.x + NODE_W),
    ...groups.map((g) => g.x + g.w),
  ) + PAD
  const height = Math.max(
    ...nodes.map((n) => n.y + NODE_H),
    ...groups.map((g) => g.y + g.h),
  ) + PAD

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  edges.forEach((edge) => {
    const a = byId[edge.from]
    const b = byId[edge.to]
    edge.x1 = a.x + NODE_W
    edge.y1 = a.y + NODE_H / 2
    edge.x2 = b.x
    edge.y2 = b.y + NODE_H / 2
    edge.failed = a.status === 'error' || b.status === 'error'
    // An edge that runs back to the left is the loop closing: the planner asked for
    // another iteration. Every such edge is routed through the empty row above the band
    // it lands in, so a band of four tools returning at once reads as one channel
    // rather than four lines cutting across the work they did.
    edge.loop = edge.x2 < edge.x1
    if (edge.loop && b.row > 0) edge.mid = y(b.row - 1) + NODE_H / 2
  })

  return {
    nodes,
    edges,
    groups,
    width,
    height,
    hiddenCount: nodes.reduce((n, node) => n + node.hidden, 0),
  }
}
