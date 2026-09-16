import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  FLOW_COLOURS,
  NODE_H,
  NODE_W,
  buildFlow,
} from './flow/model'

const MIN_K = 0.2
// The scale a first look opens at. Below this the boxes are shapes rather than
// writing, so a graph too large to fit opens at its start instead of shrunk to fit.
const READABLE_K = 0.52
const MAX_K = 1.6

/** A polyline with its corners rounded — the routing a loop-back edge takes. */
function rounded(points, r = 12) {
  return points
    .map(([x, y], i) => {
      if (i === 0) return `M ${x} ${y}`
      if (i === points.length - 1) return `L ${x} ${y}`
      const [px, py] = points[i - 1]
      const [nx, ny] = points[i + 1]
      const t = (ax, ay, bx, by) => {
        const d = Math.hypot(bx - ax, by - ay) || 1
        const k = Math.min(r, d / 2) / d
        return [ax + (bx - ax) * k, ay + (by - ay) * k]
      }
      const [ix, iy] = t(x, y, px, py)
      const [ox, oy] = t(x, y, nx, ny)
      return `L ${ix} ${iy} Q ${x} ${y} ${ox} ${oy}`
    })
    .join(' ')
}

/**
 * The connector between two boxes: out of the right edge, into the left edge.
 *
 * A forward edge is a single curve. An edge that runs backwards is the loop closing —
 * the planner asking for another iteration — and is routed down through the gutter
 * between the two bands rather than dragged back across the work it produced.
 */
function edgePath({ x1, y1, x2, y2, loop, mid: channel }) {
  if (loop) {
    const out = x1 + 30
    const back = x2 - 30
    const mid = channel ?? (y1 + y2) / 2
    return rounded([
      [x1, y1],
      [out, y1],
      [out, mid],
      [back, mid],
      [back, y2],
      [x2, y2],
    ])
  }
  const dx = Math.max(34, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

function Node({ node, selected, onSelect, onFocusNode }) {
  const colour = FLOW_COLOURS[node.kind] || '#898989'
  const failed = node.status === 'error'
  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      onFocus={() => onFocusNode(node)}
      aria-pressed={selected}
      aria-label={`${node.title}. ${node.kind}. ${node.durationLabel}. ${node.subtitle || ''}`}
      className={`group/node absolute flex flex-col overflow-hidden rounded-lg border bg-paper px-3 py-2 text-left transition-all duration-200 ease-smooth hover:-translate-y-px hover:shadow-lift ${
        selected
          ? 'border-teal-dark shadow-[0_0_0_2px_rgba(34,120,138,0.28),0_18px_36px_-24px_rgba(17,34,50,0.5)]'
          : failed
            ? 'border-brand-red/40 shadow-card'
            : 'border-line shadow-card hover:border-line-strong'
      }`}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: failed ? '#E82B2B' : colour }}
        aria-hidden="true"
      />
      <span className="flex items-center justify-between gap-2 pl-1.5">
        <span
          className="truncate text-[9.5px] font-semibold uppercase tracking-eyebrow"
          style={{ color: failed ? '#D41F1F' : colour }}
        >
          {node.kind}
        </span>
        <span className="shrink-0 text-[10px] tabular text-slate2-light">{node.durationLabel}</span>
      </span>
      <span className="mt-[3px] truncate pl-1.5 text-table font-medium text-navy">{node.title}</span>
      {node.subtitle && (
        <span className="mt-[1px] truncate pl-1.5 font-serif text-[11.5px] leading-[15px] text-slate2">
          {node.subtitle}
        </span>
      )}
      <span className="mt-auto flex items-center gap-1.5 overflow-hidden pl-1.5">
        {node.badges.slice(0, 2).map((badge) => (
          <span
            key={badge}
            // A short figure keeps its width; only the wordier badge beside it gives
            // way, so "8 evidence" never truncates to "8 evide…".
            className={`truncate rounded-sm bg-paper-tint px-1.5 py-[2px] text-[10px] tabular text-slate2 ring-1 ring-inset ring-line ${
              badge.length <= 13 ? 'shrink-0' : ''
            }`}
          >
            {badge}
          </span>
        ))}
        {node.hidden > 0 && (
          <span className="shrink-0 text-[10px] tabular text-slate2-light">+{node.hidden}</span>
        )}
      </span>
    </button>
  )
}

/**
 * The run drawn as a workflow: every recorded span in the order one fed the next.
 *
 * It is a reading of the trace, not a second source of truth — selecting a box selects
 * that span, and the detail panel underneath is the same one the timeline drives.
 */
export default function FlowMap({ run, spans, guardrails, detail, selected, onSelect, height = 440 }) {
  const flow = useMemo(() => buildFlow(run, spans, guardrails, detail), [run, spans, guardrails, detail])
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const frame = useRef(null)
  const drag = useRef(null)

  const fit = useCallback((floor = MIN_K) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || !flow.width) return
    const k = Math.min(
      MAX_K,
      Math.max(floor, Math.min(box.width / flow.width, box.height / flow.height)),
    )
    // Centred when the whole graph fits; otherwise pinned to its start, which is
    // where the run starts too.
    setView({
      k,
      x: flow.width * k <= box.width ? (box.width - flow.width * k) / 2 : 10,
      y: flow.height * k <= box.height ? (box.height - flow.height * k) / 2 : 10,
    })
  }, [flow])

  // Frame the graph whenever it or the viewport changes shape, so something legible is
  // on screen before anyone reaches for a control.
  useLayoutEffect(() => {
    fit(READABLE_K)
  }, [fit, height])

  useEffect(() => {
    const el = frame.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const box = el.getBoundingClientRect()
      setSize({ w: box.width, h: box.height })
      fit(READABLE_K)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit])

  // Wheel has to be bound by hand: React's onWheel is passive, and zooming without
  // preventing the default scrolls the page out from under the canvas.
  useEffect(() => {
    const el = frame.current
    if (!el) return undefined
    const onWheel = (e) => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      const px = e.clientX - box.left
      const py = e.clientY - box.top
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.0015)))
        const ratio = k / v.k
        return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoom = (factor) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    const px = box.width / 2
    const py = box.height / 2
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
      const ratio = k / v.k
      return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio }
    })
  }

  // Tabbing through the boxes has to bring them into view, or a keyboard reader ends
  // up focused on something off-canvas.
  const revealNode = (node) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    setView((v) => {
      const left = node.x * v.k + v.x
      const top = node.y * v.k + v.y
      const right = left + NODE_W * v.k
      const bottom = top + NODE_H * v.k
      const m = 24
      let { x, y } = v
      if (left < m) x += m - left
      if (right > box.width - m) x -= right - (box.width - m)
      if (top < m) y += m - top
      if (bottom > box.height - m) y -= bottom - (box.height - m)
      return { ...v, x, y }
    })
  }

  const onPointerDown = (e) => {
    if (e.target.closest('button')) return
    drag.current = { x: e.clientX, y: e.clientY, view }
    setPanning(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e) => {
    if (!drag.current) return
    setView({
      ...drag.current.view,
      x: drag.current.view.x + (e.clientX - drag.current.x),
      y: drag.current.view.y + (e.clientY - drag.current.y),
    })
  }
  const endDrag = () => {
    drag.current = null
    setPanning(false)
  }

  return (
    <div className="relative">
      <div
        ref={frame}
        className={`relative overflow-hidden rounded-lg border border-line bg-paper-soft ${
          panning ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          height,
          backgroundImage: 'radial-gradient(#DDE5EA 1px, transparent 1px)',
          backgroundSize: `${22 * view.k}px ${22 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        role="group"
        aria-label="Workflow map of this run. Select a step to see what it recorded."
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
            width: flow.width,
            height: flow.height,
          }}
        >
          <svg
            className="absolute left-0 top-0 overflow-visible"
            width={flow.width}
            height={flow.height}
            aria-hidden="true"
          >
            {/* The frame an iteration drew around its own work. */}
            {flow.groups.map((group) => (
              <g key={group.id}>
                <rect
                  x={group.x}
                  y={group.y}
                  width={group.w}
                  height={group.h}
                  rx="14"
                  fill="rgba(244, 247, 249, 0.72)"
                  stroke="#C9D3DA"
                  strokeDasharray="5 5"
                />
                <text x={group.x + 16} y={group.y + 18} fontSize="11.5">
                  <tspan fill="#112232" fontWeight="600">{group.label}</tspan>
                  {group.note && (
                    <tspan dx="10" fill="#767676" fontSize="11">
                      {group.note}
                    </tspan>
                  )}
                </text>
              </g>
            ))}

            {flow.edges.map((edge) => (
              <g key={edge.id}>
                {/* pathLength normalises every connector to 1, so the one dash length
                    in .edge-draw draws them all however far apart two steps sit. */}
                <path
                  d={edgePath(edge)}
                  pathLength="1"
                  fill="none"
                  stroke={edge.failed ? '#E82B2B' : '#B8C6CE'}
                  strokeWidth={edge.kind === 'branch' ? 1 : 1.6}
                  opacity={edge.kind === 'branch' ? 0.7 : 1}
                  className="edge-draw"
                />
                <circle cx={edge.x1} cy={edge.y1} r="2.6" fill={edge.failed ? '#E82B2B' : '#B8C6CE'} />
                <circle
                  cx={edge.x2}
                  cy={edge.y2}
                  r="3.4"
                  fill="#FFFFFF"
                  stroke={edge.failed ? '#E82B2B' : '#B8C6CE'}
                  strokeWidth="1.6"
                />
              </g>
            ))}
          </svg>

          {flow.nodes.map((node) => (
            <Node
              key={node.id}
              node={node}
              selected={node.spanId === selected && node.kind !== 'start' && node.kind !== 'end'}
              onSelect={onSelect}
              onFocusNode={revealNode}
            />
          ))}
        </div>

        {/* Which way the graph continues past the frame. Without these a reader who
            opens on a long run has no way to tell there is more to the right. */}
        {view.x < -4 && <span className="map-fade left-0 bg-gradient-to-r" aria-hidden="true" />}
        {flow.width * view.k + view.x > size.w + 4 && (
          <span className="map-fade right-0 bg-gradient-to-l" aria-hidden="true" />
        )}

        {/* Viewport controls. Bottom right, because a run is drawn from the top left and
            that corner is the one it is least likely to grow into. */}
        <div className="absolute bottom-3 right-3 z-[2] flex items-center gap-1 rounded-md border border-line bg-paper/90 p-1 shadow-card backdrop-blur-sm">
          <button type="button" className="map-btn" onClick={() => zoom(1 / 1.25)} aria-label="Zoom out">
            −
          </button>
          <span className="w-10 text-center text-[10.5px] tabular text-slate2">
            {Math.round(view.k * 100)}%
          </span>
          <button type="button" className="map-btn" onClick={() => zoom(1.25)} aria-label="Zoom in">
            +
          </button>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
          <button type="button" className="map-btn px-2" onClick={() => fit()} title="Show the whole run">
            Fit
          </button>
        </div>
      </div>
    </div>
  )
}
