import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const CARD_WIDTH = 392
const GAP = 16 // between the spotlight and the card
const EDGE = 12 // the closest the card comes to the viewport edge
const PAD = 8 // how far the spotlight is opened out around its element

/**
 * Wait for the element a stop points at.
 *
 * A stop navigates before it is read, so the element it wants usually does not exist yet
 * — and on a screen that fetches first it may take a moment longer. This polls briefly
 * and then gives up: a stop whose anchor never arrives is shown centred rather than
 * holding the tour up, which is what happens on a screen with no data yet.
 */
function useAnchor(anchor, stepId) {
  const [element, setElement] = useState(null)

  useEffect(() => {
    setElement(null)
    if (!anchor) return undefined

    let done = false
    let marginTimer = 0
    let clearMargin = null
    // Several places carry the same anchor — the navigation exists twice, once for the
    // rail and once for the header below lg — so this takes the one actually on screen
    // rather than the first in the document, which may be the hidden one.
    const found = () => {
      const all = Array.from(document.querySelectorAll(`[data-tour="${anchor}"]`))
      return (
        all.find((el) => {
          const box = el.getBoundingClientRect()
          return box.width > 0 && box.height > 0
        }) || null
      )
    }

    const settle = (el) => {
      done = true
      setElement(el)
      // Centring is right for most targets. A tall one — a trace diagram, a metrics
      // table — is taller than the space left beside it, so the card ends up docked over
      // its lower half; bringing it to the top of the viewport instead leaves as much of
      // it as possible standing clear above the card. The scroll margin keeps the
      // spotlight's outline off the viewport edge, and is removed once the scroll lands
      // so nothing of ours is left on the page.
      // "No room beside it, and too tall to sit under when centred" — which is every
      // full-width panel on these screens, and none of the small targets like the
      // composer or a rail item.
      const box = el.getBoundingClientRect()
      const tall =
        box.height > window.innerHeight * 0.3 && box.width > window.innerWidth - (CARD_WIDTH + 110)
      if (tall) el.style.scrollMarginTop = '24px'
      el.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: 'smooth' })
      if (tall) {
        clearMargin = () => {
          el.style.scrollMarginTop = ''
          clearMargin = null
        }
        marginTimer = window.setTimeout(() => clearMargin?.(), 1200)
      }
    }

    const immediate = found()
    if (immediate) settle(immediate)

    const poll = window.setInterval(() => {
      if (done) return
      const el = found()
      if (el) settle(el)
    }, 60)
    const giveUp = window.setTimeout(() => {
      done = true
      window.clearInterval(poll)
    }, 2500)

    return () => {
      window.clearInterval(poll)
      window.clearTimeout(giveUp)
      window.clearTimeout(marginTimer)
      clearMargin?.()
    }
  }, [anchor, stepId])

  return element
}

/** The element's box in viewport coordinates, kept current as the page moves under it. */
function useRect(element) {
  const [rect, setRect] = useState(null)

  useEffect(() => {
    if (!element) {
      setRect(null)
      return undefined
    }

    let frame = 0
    const measure = () => {
      const box = element.getBoundingClientRect()
      // An element that has been unmounted, or collapsed to nothing, is not worth
      // drawing a hole around.
      setRect(box.width || box.height ? box : null)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }

    measure()
    // The smooth scroll into view is still running when this mounts, and the last scroll
    // event can land a frame before the page has actually stopped — which is enough to
    // leave the card sitting over the edge of the thing it is describing. `scrollend` is
    // the reliable signal where it exists; the timers cover the browsers where it does
    // not, and cost nothing but a handful of measurements.
    const settles = [120, 320, 620, 900].map((delay) => window.setTimeout(measure, delay))
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('scrollend', schedule, true)
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(element)

    return () => {
      cancelAnimationFrame(frame)
      settles.forEach(window.clearTimeout)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('scrollend', schedule, true)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [element])

  return rect
}

/**
 * Where the card goes.
 *
 * The stop states a preference; this honours it only if the card fits there, and
 * otherwise tries the other three sides before docking the card to the foot of the
 * viewport. Narrow screens skip the whole calculation and always dock, because beside a
 * spotlight there is nowhere to stand.
 */
function place(rect, size, viewport) {
  const { width: vw, height: vh } = viewport
  const { width: w, height: h } = size
  const docked = {
    placement: 'docked',
    left: Math.max(EDGE, (vw - w) / 2),
    top: Math.max(EDGE, vh - h - EDGE * 2),
  }
  if (vw < 700) return docked
  // A stop with nothing to point at is addressing the whole screen, so it sits in the
  // middle of it rather than clinging to the foot of the page like a placed card.
  if (!rect) return { placement: 'centre', left: Math.max(EDGE, (vw - w) / 2), top: Math.max(EDGE, (vh - h) / 2) }

  const clampX = (x) => Math.min(Math.max(x, EDGE), Math.max(EDGE, vw - w - EDGE))
  const clampY = (y) => Math.min(Math.max(y, EDGE), Math.max(EDGE, vh - h - EDGE))

  const options = {
    bottom: {
      fits: rect.bottom + GAP + h <= vh - EDGE,
      left: clampX(rect.left + rect.width / 2 - w / 2),
      top: rect.bottom + GAP,
    },
    top: {
      fits: rect.top - GAP - h >= EDGE,
      left: clampX(rect.left + rect.width / 2 - w / 2),
      top: Math.max(EDGE, rect.top - GAP - h),
    },
    right: {
      fits: rect.right + GAP + w <= vw - EDGE,
      left: rect.right + GAP,
      top: clampY(rect.top + rect.height / 2 - h / 2),
    },
    left: {
      fits: rect.left - GAP - w >= EDGE,
      left: Math.max(EDGE, rect.left - GAP - w),
      top: clampY(rect.top + rect.height / 2 - h / 2),
    },
  }

  // The stated preference first, then the other three sides, then the foot of the page.
  for (const name of [viewport.preferred || 'bottom', 'bottom', 'top', 'right', 'left']) {
    const option = options[name]
    if (option?.fits) return { placement: name, left: option.left, top: option.top }
  }
  return docked
}

/**
 * The guided tour, on screen.
 *
 * One hole in a dimmed page, one card beside it, and a bar across the top of the card
 * saying how far through this is. The dimmed area swallows clicks on purpose: a reader
 * halfway through the tour should not be able to start an evaluation run by accident,
 * and every way out — Escape, Skip, the close button — is deliberate and visible.
 *
 * The hole is drawn as a single element with an enormous spread shadow rather than four
 * panels or an SVG mask: it is one box to move, so moving between stops animates as one
 * gesture, and it costs nothing on a screen that is also streaming tokens.
 */
export default function TourOverlay({
  step,
  index,
  total,
  onNext,
  onBack,
  onClose,
  suppressed,
  onSuppress,
}) {
  const element = useAnchor(step.anchor, step.id)
  const rect = useRect(element)
  const card = useRef(null)
  const [size, setSize] = useState({ width: CARD_WIDTH, height: 280 })
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  const last = index === total - 1
  const first = index === 0

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Measured rather than assumed: the stops are not all the same length, and a card
  // placed from a guess at its height lands over the thing it is describing.
  useLayoutEffect(() => {
    if (!card.current) return undefined
    const measure = () => {
      const box = card.current?.getBoundingClientRect()
      if (box) setSize({ width: box.width, height: box.height })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer && card.current) observer.observe(card.current)
    return () => observer?.disconnect()
  }, [step.id])

  // Reading order starts at the card on every stop, so a screen reader hears the new
  // stop rather than wherever focus happened to be left.
  useEffect(() => {
    card.current?.focus({ preventScroll: true })
  }, [step.id])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        onNext()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onBack()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onNext, onBack, onClose])

  const width = Math.min(CARD_WIDTH, viewport.width - EDGE * 2)
  const pad = step.padding ?? PAD
  const position = place(rect, { width, height: size.height }, { ...viewport, preferred: step.placement })
  const progress = Math.round(((index + 1) / total) * 100)

  return (
    <div className="fixed inset-0 z-[60]" role="presentation">
      {/* Swallows every click that is not on the card. */}
      <div
        className="absolute inset-0"
        onClick={(e) => e.stopPropagation()}
        aria-hidden="true"
        style={{ cursor: 'default' }}
      />

      {rect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg transition-all duration-500 ease-smooth"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px rgba(10, 23, 36, 0.58)',
            outline: '2px solid rgba(117, 201, 214, 0.9)',
            outlineOffset: '-1px',
          }}
        />
      ) : (
        <div
          aria-hidden="true"
          className="veil absolute inset-0"
          style={{ background: 'rgba(10, 23, 36, 0.58)' }}
        />
      )}

      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        tabIndex={-1}
        className="absolute overflow-hidden rounded-xl border border-line bg-paper shadow-lift outline-none transition-[left,top] duration-500 ease-smooth"
        style={{ left: position.left, top: position.top, width }}
      >
        {/* How far through, before anything else — a tour with no visible end is one
            people leave. */}
        <div className="h-[3px] w-full bg-line" role="presentation">
          <div
            className="h-full bg-gradient-to-r from-brand-redInk to-brand-red transition-[width] duration-500 ease-smooth"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="px-5 pb-4 pt-4 sm:px-6">
          <div className="flex items-baseline justify-between gap-4">
            <p className="eyebrow truncate">{step.chapter}</p>
            <p className="shrink-0 text-meta tabular text-slate2-light" aria-live="polite">
              Step {index + 1} of {total}
            </p>
          </div>

          <h2
            id="tour-step-title"
            className="brand-rule mt-2.5 font-serif text-[19px] font-semibold leading-[1.28] tracking-[-0.01em] text-navy"
          >
            {step.title}
          </h2>

          <div className="mt-2.5 space-y-2.5">
            {step.body.map((paragraph) => (
              <p key={paragraph.slice(0, 32)} className="font-serif text-quote leading-[24px] text-slate2">
                {paragraph}
              </p>
            ))}
          </div>

          {/* The point of the stop for someone carrying model risk, set apart on the
              brand's own rule so it reads as the takeaway rather than more prose. */}
          {step.note && (
            <p className="mt-3.5 border-l-2 border-brand-red pl-3 text-meta font-medium leading-[17px] text-teal-dark">
              {step.note}
            </p>
          )}

          {last && (
            <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-meta text-slate2 transition-colors duration-200 ease-smooth hover:text-navy">
              <input
                type="checkbox"
                checked={suppressed}
                onChange={(e) => onSuppress(e.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer accent-teal-dark"
              />
              Do not show the welcome again when I sign in
            </label>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-paper-tint px-5 py-3 sm:px-6">
          <button type="button" onClick={onClose} className="btn-quiet -ml-2">
            {last ? 'Close' : 'Skip tour'}
          </button>
          <div className="flex items-center gap-2">
            {!first && (
              <button type="button" onClick={onBack} className="btn px-3.5 py-2">
                Back
              </button>
            )}
            <button type="button" onClick={onNext} className="btn-brand px-4 py-2">
              {last ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
