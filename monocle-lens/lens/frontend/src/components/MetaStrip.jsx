export const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)
export const fmtUsd = (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`)
export const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString())
export const sectionTail = (path) => (path ? path.split(' > ').slice(1).join(' › ') || path : '')

/**
 * The shortest reference that still identifies a passage, for inline citations.
 * "Principle 2 > 2.4 Independent validation" becomes "2.4"; "VI > Effective
 * Challenge" becomes "VI". Falls back to a trimmed heading when a document
 * numbers nothing.
 */
export const sectionRef = (path) => {
  const parts = sectionTail(path).split(' › ').filter(Boolean)
  const last = parts[parts.length - 1] || ''
  const numbered = last.match(/^\d+(?:[.(][\dA-Za-z)]+)*/)
  if (numbered) return numbered[0]
  // Some frameworks number the parent instead (Roman numerals, single letters).
  const parent = parts[parts.length - 2] || ''
  if (parent && /^[IVXLC]+$|^[A-Z]$|^\d/.test(parent)) return parent
  return last.length > 16 ? `${last.slice(0, 15).trimEnd()}…` : last
}

/** One figure and the word naming it. The figure is the thing being read, so it
 *  is set larger and darker than its label. */
export function Stat({ label, value, mono }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] leading-4 text-slate2-light">{label}</dt>
      <dd className={`mt-[1px] text-table font-medium tabular text-navy ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

/**
 * The instrument panel that sits under every answer: what it cost, what ran it,
 * and which prompt version produced it. Reading the value is the job, so the
 * value is set larger and darker than the thing naming it.
 *
 * items: [label, value, mono?][] — falsy entries are dropped.
 */
export default function MetaStrip({ items }) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3 border-y border-line py-3">
      {items.filter(Boolean).map(([label, value, mono]) => (
        <Stat key={label} label={label} value={value} mono={mono} />
      ))}
    </dl>
  )
}
