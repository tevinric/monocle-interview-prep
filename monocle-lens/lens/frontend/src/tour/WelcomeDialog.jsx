import { useEffect, useRef } from 'react'
import LensMark from '../components/LensMark'

/** Morning, afternoon or evening, from the reader's own clock. */
function partOfDay(date = new Date()) {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * The one moment the interface addresses the person by name.
 *
 * It appears once per sign-in, offers the tour, and takes no for an answer — including
 * permanently. Declining is not the small print: "Explore on my own" is a button of equal
 * weight beside the offer, and Escape or a click on the backdrop does the same thing.
 *
 * The name is the `given_name` claim from Entra. Where there is none — a DEV session with
 * sign-in bypassed — the greeting drops the name rather than guessing at one.
 */
export default function WelcomeDialog({
  firstName,
  preparing,
  suppressed,
  onSuppress,
  onStart,
  onDismiss,
}) {
  const primary = useRef(null)
  const card = useRef(null)

  useEffect(() => {
    primary.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onDismiss()
      // A modal offer should not let focus wander into an application nobody can see.
      if (e.key === 'Tab') {
        const focusable = card.current?.querySelectorAll(
          'button, input, [href], [tabindex]:not([tabindex="-1"])',
        )
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="veil absolute inset-0 cursor-default bg-navy-deep/55 backdrop-blur-[2px]"
      />

      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-welcome-title"
        className="item-in relative w-full max-w-[560px] overflow-hidden rounded-xl bg-navy text-paper shadow-lift"
      >
        {/* The Monocle diagonal, at the scale of the block it sits in. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-16 h-[180%] w-[300px] -skew-x-[18deg] opacity-70"
          style={{
            // Two gradients: the vertical fade is the brand wash, and the horizontal one
            // softens the trailing edge so the wedge reads as a tint in the corner rather
            // than as a shape cut out of the card.
            background:
              'linear-gradient(to bottom, rgba(232,43,43,0.26), rgba(232,43,43,0.06) 55%, transparent 85%)',
            maskImage: 'linear-gradient(to left, #000 45%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to left, #000 45%, transparent 100%)',
          }}
        />

        <div className="relative px-7 py-8 sm:px-9 sm:py-10">
          <LensMark className="h-9 w-9 opacity-90" aria-hidden="true" />

          <p className="eyebrow-dark mt-6">Monocle Lens</p>
          <h2
            id="tour-welcome-title"
            className="mt-3 font-serif text-[26px] font-semibold leading-[1.18] tracking-[-0.01em] sm:text-[30px]"
          >
            {partOfDay()}
            {firstName ? `, ${firstName}` : ''}.
          </h2>

          <p className="mt-4 max-w-[52ch] font-serif text-quote leading-[26px] text-teal">
            A regulatory research agent whose audit trail is the product — built by Tevin Richard
            for Monocle Tech.
          </p>
          <p className="mt-3 max-w-[54ch] text-body text-slate2-onDark">
            Two minutes for the guided tour: the agent, its traces, the evidence and the audit pack.
            Stop whenever you like.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              type="button"
              ref={primary}
              onClick={onStart}
              disabled={preparing}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-brand-redInk bg-brand-redInk px-5 py-2.5 text-table font-semibold text-paper shadow-card transition-all duration-200 ease-smooth hover:-translate-y-px hover:border-brand-redDeep hover:bg-brand-redDeep hover:shadow-lift active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >
              {preparing ? (
                <>
                  <span className="pulse h-1.5 w-1.5 rounded-full bg-paper" aria-hidden="true" />
                  Starting the tour
                </>
              ) : (
                'Yes, show me around'
              )}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center justify-center rounded-md border border-paper/25 px-5 py-2.5 text-table font-medium text-paper transition-colors duration-200 ease-smooth hover:border-paper/50 hover:bg-paper/10"
            >
              Explore on my own
            </button>
          </div>

          <label className="mt-7 flex cursor-pointer items-center gap-2.5 border-t border-navy-rule pt-5 text-meta text-slate2-onDark transition-colors duration-200 ease-smooth hover:text-paper">
            <input
              type="checkbox"
              checked={suppressed}
              onChange={(e) => onSuppress(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-teal-dark"
            />
            Do not show this again when I sign in
          </label>
          <p className="mt-2 text-meta text-slate2-onDark/70">
            The tour stays available from Guided tour in the sidebar.
          </p>
        </div>
      </div>
    </div>
  )
}
