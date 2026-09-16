import { useEffect, useRef, useState } from 'react'
import LensMark from '../components/LensMark'

/**
 * The sign-in gate.
 *
 * Four things on the card and nothing else: the mark, the name, what it is, and the way
 * in. A sign-in page is read by whoever finds the URL, so it explains itself in one line
 * and leaves everything else until there is an account.
 *
 * The movement belongs to the backdrop rather than the card. Rings open out from behind
 * the mark — an aperture finding focus, which is what the product is named for — over two
 * drifting auras and a diagonal that crosses on the brand's own angle. The whole field
 * leans with the pointer. Nothing but transform and opacity is animated, so it stays on
 * the compositor, and prefers-reduced-motion stops all of it, parallax included.
 */
function Backdrop({ lean }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden bg-navy-deep">
      {/* Two auras, on separate parallax planes so the field has depth. The wrapper
          carries the lean and the child carries the drift: one transform each. */}
      <div className="parallax" style={{ '--depth': 1 }} ref={lean}>
        <span className="aura aura-a" />
      </div>
      <div className="parallax" style={{ '--depth': 1.9 }} ref={lean}>
        <span className="aura aura-b" />
      </div>

      {/* The aperture, opened out across the page. Five rings on one cycle, each a
          third of a beat behind the last. */}
      <div className="parallax" style={{ '--depth': 2.6 }} ref={lean}>
        <div className="rings">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="ring" style={{ '--i': i }} />
          ))}
        </div>
      </div>

      {/* A fine grid for the drift to move against, held off the edges. */}
      <div
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            'linear-gradient(rgba(117,201,214,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(117,201,214,0.07) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(70% 60% at 50% 48%, #000 15%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(70% 60% at 50% 48%, #000 15%, transparent 100%)',
        }}
      />

      {/* The Monocle diagonal, as a pass of light on the brand's angle. */}
      <span className="sweep" />

      {/* Darkened at the edges, so the card sits in the light rather than on top of it. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(92% 72% at 50% 48%, transparent 24%, rgba(8,18,29,0.55) 62%, rgba(6,14,23,0.9) 100%)',
        }}
      />
    </div>
  )
}

export default function Login({ onSignIn, error }) {
  const [busy, setBusy] = useState(false)
  const planes = useRef([])
  const root = useRef(null)

  // Collect the parallax planes as they mount, then move them from one pointer handler
  // rather than from React state: this runs on every mouse move, and a re-render per
  // frame is the one thing that would make it feel cheap.
  const lean = (node) => {
    if (node && !planes.current.includes(node)) planes.current.push(node)
  }

  useEffect(() => {
    const element = root.current
    if (!element) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined

    let frame = 0
    let x = 0
    let y = 0
    const apply = () => {
      frame = 0
      planes.current.forEach((plane) => {
        plane.style.setProperty('--x', x.toFixed(4))
        plane.style.setProperty('--y', y.toFixed(4))
      })
    }
    const onMove = (event) => {
      x = (event.clientX / window.innerWidth) * 2 - 1
      y = (event.clientY / window.innerHeight) * 2 - 1
      if (!frame) frame = requestAnimationFrame(apply)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const start = async () => {
    setBusy(true)
    try {
      await onSignIn()
    } finally {
      // The redirect normally takes the tab away before this runs; if it did not, the
      // button has to come back rather than stay spinning.
      setBusy(false)
    }
  }

  return (
    <div
      ref={root}
      className="relative flex min-h-[100dvh] flex-col items-center justify-center px-6 py-12"
    >
      <Backdrop lean={lean} />

      <main className="screen-in relative w-full max-w-[380px]">
        <div className="rounded-xl bg-paper px-9 py-11 text-center shadow-[0_2px_10px_rgba(6,15,24,0.28),0_48px_90px_-48px_rgba(0,0,0,0.85)]">
          <LensMark className="mx-auto h-[60px] w-[60px]" animated />
          <h1 className="mt-6 text-[26px] font-semibold leading-none tracking-brand text-navy">Lens</h1>
          <p className="mt-2.5 text-body text-slate2">Regulatory answers you can trace</p>

          {error && (
            <p className="notice-error mt-7 text-left" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="btn-primary mt-8 w-full py-3 text-body"
          >
            {busy ? (
              <>
                <span className="pulse h-1.5 w-1.5 rounded-full bg-paper" aria-hidden="true" />
                Opening Microsoft sign-in
              </>
            ) : (
              <>
                {/* The Microsoft mark, as their sign-in guidance asks for. The one place
                    in this interface carrying someone else's logo, and it is here so the
                    button is unmistakable rather than decorative. */}
                <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
                  <rect width="7" height="7" x="0" y="0" fill="#F25022" />
                  <rect width="7" height="7" x="9" y="0" fill="#7FBA00" />
                  <rect width="7" height="7" x="0" y="9" fill="#00A4EF" />
                  <rect width="7" height="7" x="9" y="9" fill="#FFB900" />
                </svg>
                Sign in with Microsoft
              </>
            )}
          </button>
        </div>

        <p className="mt-6 text-center text-meta text-slate2-onDark">Built by Tevin Richard</p>
      </main>
    </div>
  )
}
