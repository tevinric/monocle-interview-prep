import { useState } from 'react'

const COLLAPSE_ABOVE = 20

export default function JsonBlock({ value, label }) {
  const [open, setOpen] = useState(false)
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const lines = text.split('\n')
  const long = lines.length > COLLAPSE_ABOVE
  const shown = long && !open ? lines.slice(0, COLLAPSE_ABOVE).join('\n') : text

  return (
    <div className="mt-4">
      {label && <p className="field-label mb-1.5">{label}</p>}
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-line bg-paper-tint px-3 py-2.5 font-mono text-json text-navy">
        {shown}
        {long && !open && <span className="text-slate2-light">{'\n⋮'}</span>}
      </pre>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="btn-quiet -ml-2 mt-1.5">
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}
