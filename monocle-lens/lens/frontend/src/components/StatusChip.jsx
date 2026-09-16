// Text, never icons (CLAUDE.md §13). A hairline in the chip's own colour keeps
// the three outcomes apart at a glance without resorting to a filled block.
const STYLES = {
  ok: 'bg-paper-tint text-teal-dark ring-teal-dark/30',
  pass: 'bg-paper-tint text-teal-dark ring-teal-dark/30',
  recording: 'bg-paper-tint text-teal-dark ring-teal-dark/30',
  abstained: 'bg-paper-tint text-slate2 ring-line-strong',
  pending: 'bg-paper-tint text-slate2 ring-line-strong',
  // These two carry real status, so they take the readable grey rather than the
  // muted one, which lands at 4.2:1 on the tint. The lighter ring is what keeps
  // them quieter than `abstained` and `pending`.
  running: 'bg-paper-tint text-slate2 ring-line',
  'not ingested': 'bg-paper-tint text-slate2 ring-line',
  error: 'bg-brand-redTint text-brand-redInk ring-brand-red/30',
  fail: 'bg-brand-redTint text-brand-redInk ring-brand-red/30',
  unavailable: 'bg-brand-redTint text-brand-redInk ring-brand-red/30',
}

export default function StatusChip({ status, children }) {
  const key = String(status || '').toLowerCase()
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-[3px] text-meta font-medium ring-1 ring-inset ${
        STYLES[key] || STYLES.pending
      }`}
    >
      {children || status}
    </span>
  )
}
