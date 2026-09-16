/**
 * Loading that keeps the shape of what is coming.
 *
 * A row of shimmering bars in the proportions of the real thing reads as "this is
 * arriving"; the words "Loading…" read as "nothing is happening yet". Both are
 * announced the same way to a screen reader, via the `aria-busy` region each of
 * these sits inside — the bars themselves are decorative.
 */
export function SkeletonLine({ className = '' }) {
  return <span className={`skeleton block h-3 ${className}`} aria-hidden="true" />
}

/** Placeholder rows in the shape of a table. `cols` are Tailwind widths. */
export function SkeletonTable({ rows = 6, cols = ['w-24', 'w-full', 'w-16', 'w-20', 'w-12', 'w-14'] }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="mt-6">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-4 border-b border-line px-3.5 py-4"
          // Each row starts its shimmer a beat after the one above, so the block
          // reads as filling in rather than flashing.
          style={{ animationDelay: `${r * 60}ms` }}
        >
          {cols.map((w, c) => (
            <SkeletonLine key={c} className={`${w} ${c === 1 ? 'flex-1' : 'shrink-0'}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Placeholder blocks in the shape of the corpus cards. */
export function SkeletonCards({ count = 3 }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="mt-2">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="max-w-[900px] border-b border-line py-6">
          <SkeletonLine className="w-20" />
          <SkeletonLine className="mt-3 h-4 w-2/3" />
          <SkeletonLine className="mt-2.5 w-40" />
          <div className="mt-5 flex gap-8">
            {['w-16', 'w-16', 'w-14', 'w-12'].map((w, j) => (
              <SkeletonLine key={j} className={w} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export default SkeletonLine
