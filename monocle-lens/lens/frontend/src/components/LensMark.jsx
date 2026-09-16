/**
 * The Lens mark: an aperture cut by the diagonal.
 *
 * The same drawing as `public/favicon.svg`, inlined so its parts can be animated and so
 * the ring takes `currentColor` where that reads better than the fixed teal. It is the
 * product's own mark and carries no Monocle letterforms — this is what stands alone on
 * the sign-in page, before anything has identified itself as anyone's product.
 *
 * `animated` gives the aperture a slow focus: the ring breathes, and the diagonal draws
 * itself once on arrival. Both stop dead under prefers-reduced-motion (index.css).
 */
export default function LensMark({ className = '', animated = false, title = 'Lens' }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="#112232" />
      {/* The aperture. Two rings: the mark itself, and a wider one that breathes
          around it so the lens reads as focusing rather than sitting still. */}
      {animated && (
        <circle
          cx="16"
          cy="16"
          r="7"
          fill="none"
          stroke="#75C9D6"
          strokeWidth="1"
          className="mark-pulse"
        />
      )}
      <circle cx="16" cy="16" r="7" fill="none" stroke="#75C9D6" strokeWidth="2.6" />
      <path
        d="M25.5 4.5 7.5 27.5"
        stroke="#E82B2B"
        strokeWidth="2.6"
        strokeLinecap="round"
        pathLength="1"
        className={animated ? 'mark-draw' : undefined}
      />
    </svg>
  )
}
