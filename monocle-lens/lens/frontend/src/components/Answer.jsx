import { sectionRef } from './MetaStrip'

const MARKER = /\[(E\d+(?:\s*,\s*E\d+)*)\]/g
// A deliberately small subset. Models emit these intermittently whatever the prompt
// says, and showing a compliance reader a literal ** is worse than rendering it.
// Nothing here can inject markup: every branch returns a React element.
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9])|`[^`\n]+`)/g

const BULLET = /^\s*[-*•]\s+/
const NUMBERED = /^\s*(\d+)[.)]\s+/
const HEADING = /^\s*#{1,6}\s+/

/** The same inline formatting, for places that show answer text outside an Answer —
 *  the replay diff, which compares the exact recorded strings but should not render
 *  their markup any differently from everywhere else. */
export function InlineText({ children }) {
  const text = String(children ?? '')
  return <>{inline(text.replace(HEADING, ''), 'x')}</>
}

/** Bold, italic and code within a run of text. Returns React nodes, never HTML. */
export function inline(text, key) {
  const out = []
  let last = 0
  let match
  INLINE.lastIndex = 0
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    const k = `${key}-i${match.index}`
    if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={k} className="font-semibold text-navy">{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      out.push(
        <code key={k} className="rounded-sm bg-paper-tint px-1 py-px font-mono text-[0.85em] text-navy">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      out.push(<em key={k} className="italic">{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * One line of answer text: citation markers become chips, everything between them is
 * rendered as inline markdown. The prose is set in the serif reading face; the chips
 * stay in the sans interface face, so a citation reads as apparatus attached to the
 * text rather than as part of the sentence.
 */
function renderLine(line, key, byMarker, onCitation) {
  const parts = []
  let last = 0
  let match
  MARKER.lastIndex = 0
  while ((match = MARKER.exec(line)) !== null) {
    if (match.index > last) parts.push(...inline(line.slice(last, match.index), `${key}-t${last}`))
    match[1].split(',').forEach((raw) => {
      const marker = raw.trim()
      const citation = byMarker[marker]
      const label = citation ? `${citation.short_name} §${sectionRef(citation.section_path)}` : marker
      parts.push(
        <button
          key={`${key}-${marker}-${match.index}`}
          type="button"
          disabled={!citation}
          onClick={() => citation && onCitation(citation)}
          className="ml-[3px] inline-block whitespace-nowrap rounded bg-teal-tint px-1.5 py-[1px] align-baseline font-sans text-[10.5px] font-semibold text-teal-dark ring-1 ring-inset ring-teal/50 transition-all duration-200 ease-smooth hover:-translate-y-px hover:bg-teal hover:text-navy-deep hover:shadow-card hover:ring-teal disabled:translate-y-0 disabled:bg-paper-tint disabled:text-slate2-light disabled:shadow-none disabled:ring-line"
          title={citation ? citation.quote : 'evidence not available'}
        >
          {label}
        </button>,
      )
    })
    last = match.index + match[0].length
  }
  if (last < line.length) parts.push(...inline(line.slice(last), `${key}-t${last}`))
  return parts
}

/** Group the lines into paragraphs, lists and headings before rendering any of them. */
function blocksOf(text) {
  const blocks = []
  ;(text || '').split('\n').forEach((raw) => {
    const line = raw.trimEnd()
    // Blank lines carry no meaning here: block spacing is set by the blocks themselves.
    if (!line.trim()) return
    if (HEADING.test(line)) {
      blocks.push({ kind: 'heading', text: line.replace(HEADING, '') })
      return
    }
    const numbered = line.match(NUMBERED)
    if (numbered) {
      const item = { text: line.replace(NUMBERED, ''), marker: numbered[1] }
      const tail = blocks[blocks.length - 1]
      if (tail?.kind === 'ordered') tail.items.push(item)
      else blocks.push({ kind: 'ordered', items: [item] })
      return
    }
    if (BULLET.test(line)) {
      const item = { text: line.replace(BULLET, '') }
      const tail = blocks[blocks.length - 1]
      if (tail?.kind === 'bullets') tail.items.push(item)
      else blocks.push({ kind: 'bullets', items: [item] })
      return
    }
    blocks.push({ kind: 'paragraph', text: line })
  })
  return blocks
}

export default function Answer({ text, citations = [], onCitation, streaming = false }) {
  const byMarker = {}
  citations.forEach((c) => {
    if (!byMarker[c.marker]) byMarker[c.marker] = c
  })

  const render = (line, key) => renderLine(line, key, byMarker, onCitation)

  const blocks = blocksOf(text)
  // While tokens are still arriving the caret rides the last block, so the answer
  // reads as being written rather than as having stopped short.
  const tail = (i) => (streaming && i === blocks.length - 1 ? ' caret' : '')

  return (
    <div className="prose-read">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          return (
            <p key={i} className={`mt-6 font-sans text-[15px] font-semibold leading-[24px] text-navy first:mt-0${tail(i)}`}>
              {render(block.text, i)}
            </p>
          )
        }
        if (block.kind === 'bullets') {
          return (
            <ul key={i} className={`mt-3 space-y-2 first:mt-0${tail(i)}`}>
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-3">
                  <span className="mt-[11px] h-px w-3 shrink-0 bg-line-strong" aria-hidden="true" />
                  <span>{render(item.text, `${i}-${j}`)}</span>
                </li>
              ))}
            </ul>
          )
        }
        if (block.kind === 'ordered') {
          return (
            <ol key={i} className={`mt-3 space-y-2 first:mt-0${tail(i)}`}>
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-3">
                  <span className="mt-[6px] w-4 shrink-0 text-right font-sans text-meta font-medium tabular text-slate2">
                    {item.marker}
                  </span>
                  <span>{render(item.text, `${i}-${j}`)}</span>
                </li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i} className={`mt-4 first:mt-0${tail(i)}`}>
            {render(block.text, i)}
          </p>
        )
      })}
    </div>
  )
}
