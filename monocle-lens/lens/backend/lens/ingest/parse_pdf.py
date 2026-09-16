"""
Section-aware PDF parsing with PyMuPDF.

Produces one normalised text for the document, plus a hierarchical section tree with page
numbers and character offsets into that text. The offsets are what make citation
highlighting possible: a quote verified against a chunk maps straight back to its place in
the source section.

Headings come from the document's own fonts (size and weight), refined by the optional
heading_patterns in corpus.yaml — legal texts mark structure by wording ("Article 6",
"CHAPTER III") far more reliably than by typography.
"""
import re
from collections import Counter

import pymupdf as fitz

BOLD_FLAG = 1 << 4
LIGATURES = {'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl'}
MAX_HEADING_WORDS = 16


class Line:
    def __init__(self, text, size, bold, page_no, y0, block_index, block_lines, width_ratio):
        self.text = text
        self.size = size
        self.bold = bold
        self.page_no = page_no
        self.y0 = y0
        self.block_index = block_index
        self.block_lines = block_lines
        self.width_ratio = width_ratio
        self.level = None
        self.segment = None


def _clean(text):
    for k, v in LIGATURES.items():
        text = text.replace(k, v)
    text = text.replace('­', '').replace(' ', ' ')
    return re.sub(r'[ \t]+', ' ', text).strip()


def _page_lines(page, page_no):
    data = page.get_text('dict', sort=True)
    width = page.rect.width or 1
    lines = []
    for block_index, block in enumerate(data['blocks']):
        if block.get('type') != 0:
            continue
        block_lines = len(block.get('lines', []))
        for line in block.get('lines', []):
            spans = [s for s in line['spans'] if s['text'].strip()]
            if not spans:
                continue
            text = _clean(''.join(s['text'] for s in line['spans']))
            if not text:
                continue
            bold = all((s['flags'] & BOLD_FLAG) or 'bold' in s['font'].lower() for s in spans)
            lines.append(Line(text=text, size=round(max(s['size'] for s in spans), 1), bold=bold,
                              page_no=page_no, y0=line['bbox'][1], block_index=block_index,
                              block_lines=block_lines,
                              width_ratio=(line['bbox'][2] - line['bbox'][0]) / width))
    return lines, page.rect.height or 1


def _drop_furniture(pages):
    """Remove running headers, footers and page numbers."""
    seen = Counter()
    for lines, height in pages:
        margin = {re.sub(r'\d+', '#', l.text.lower()) for l in lines
                  if l.y0 < height * 0.07 or l.y0 > height * 0.92}
        seen.update(margin)
    threshold = max(3, int(0.3 * len(pages)))
    furniture = {k for k, c in seen.items() if c >= threshold}
    out = []
    for lines, height in pages:
        keep = []
        for line in lines:
            in_margin = line.y0 < height * 0.07 or line.y0 > height * 0.92
            key = re.sub(r'\d+', '#', line.text.lower())
            if in_margin and (key in furniture or re.fullmatch(r'(page )?\d{1,4}( of \d{1,4})?', key.strip())):
                continue
            keep.append(line)
        out.append(keep)
    return out


def _body_size(lines):
    sizes = Counter()
    for line in lines:
        sizes[line.size] += len(line.text)
    return sizes.most_common(1)[0][0] if sizes else 10.0


def _compile_patterns(doc_meta):
    return [{'level': p['level'], 'regex': re.compile(p['regex'])} for p in doc_meta.get('heading_patterns') or []]


def _mark_headings(lines, patterns, body_size):
    """Assign heading levels; returns the set of line indexes consumed as heading titles."""
    consumed = set()
    if patterns:
        for i, line in enumerate(lines):
            for pattern in patterns:
                if pattern['regex'].match(line.text):
                    line.level = pattern['level']
                    line.segment = line.text
                    # A bare label ("Article 6") is usually followed by its title on the next line.
                    nxt = lines[i + 1] if i + 1 < len(lines) else None
                    if (nxt and len(line.text) <= 40 and not line.text.endswith(('.', ':'))
                            and len(nxt.text) <= 120 and not nxt.text.endswith('.')
                            and (nxt.bold or nxt.text.isupper())
                            and not any(p['regex'].match(nxt.text) for p in patterns)):
                        line.segment = f'{line.text} — {nxt.text}'
                        consumed.add(i + 1)
                    break
        return consumed

    heading_sizes = sorted({line.size for line in lines if line.size >= body_size + 1.0}, reverse=True)[:3]
    for line in lines:
        words = len(line.text.split())
        if words > MAX_HEADING_WORDS or line.text.endswith((',', ';', '.')):
            continue
        if line.size in heading_sizes:
            line.level = heading_sizes.index(line.size) + 1
        elif line.bold and line.block_lines == 1 and words <= 12 and line.width_ratio < 0.85:
            line.level = min(len(heading_sizes) + 1, 3)
        if line.level:
            line.segment = line.text
    return consumed


def parse_pdf(path, doc_meta):
    document = fitz.open(path)
    pages = [_page_lines(page, i + 1) for i, page in enumerate(document)]
    page_count = len(pages)
    kept = _drop_furniture(pages)
    lines = [line for page_lines in kept for line in page_lines]
    if not lines:
        raise ValueError('no extractable text (is this a scanned PDF?)')

    consumed = _mark_headings(lines, _compile_patterns(doc_meta), _body_size(lines))

    # ── build the normalised text, remembering where every line landed ──────
    parts, records, length, previous = [], [], 0, None
    for i, line in enumerate(lines):
        if i in consumed:
            continue
        separator = ''
        if previous is not None:
            joined = (previous.text.endswith('-') and len(previous.text) > 1
                      and previous.text[-2].islower() and line.text[:1].islower() and not previous.level)
            if joined:
                parts[-1] = parts[-1][:-1]
                length -= 1
                records[-1]['end'] -= 1
            else:
                separator = '\n\n' if (line.level or line.block_index != previous.block_index
                                       or line.page_no != previous.page_no) else '\n'
        if separator:
            parts.append(separator)
            length += len(separator)
        start = length
        parts.append(line.text)
        length += len(line.text)
        records.append({'start': start, 'end': length, 'page_no': line.page_no,
                        'level': line.level, 'segment': line.segment})
        previous = line
    text = ''.join(parts)

    # ── sections ────────────────────────────────────────────────────────────
    short_name = doc_meta.get('short_name') or doc_meta['key']
    sections, stack, current, group = [], [], None, 0
    seen_paths = set()

    def close(at):
        if current and at > current['char_start']:
            current['char_end'] = at
            current['text'] = text[current['char_start']:at]
            sections.append(current)

    for record in records:
        if not record['level']:
            continue
        close(record['start'])
        while stack and stack[-1][0] >= record['level']:
            stack.pop()
        stack.append((record['level'], record['segment']))
        if len(stack) == 1:
            group += 1
        path_ = ' > '.join([short_name] + [segment for _, segment in stack])
        suffix = 2
        while path_ in seen_paths:
            path_ = f"{' > '.join([short_name] + [s for _, s in stack])} ({suffix})"
            suffix += 1
        seen_paths.add(path_)
        current = {'section_path': path_, 'heading': record['segment'], 'level': record['level'],
                   'page_start': record['page_no'], 'char_start': record['start'], 'group': max(group, 1)}
    close(len(text))

    if not sections or sections[0]['char_start'] > 0:
        preamble_end = sections[0]['char_start'] if sections else len(text)
        sections.insert(0, {'section_path': f'{short_name} > Front matter', 'heading': 'Front matter', 'level': 1,
                            'page_start': 1, 'char_start': 0, 'char_end': preamble_end,
                            'text': text[:preamble_end], 'group': 0})

    page_starts = [(r['start'], r['page_no']) for r in records]
    for i, section in enumerate(sections):
        section['ordinal'] = i
        section['page_end'] = next((p for s, p in reversed(page_starts) if s < section['char_end']),
                                   section['page_start'])
    document.close()
    return {'text': text, 'sections': sections, 'page_starts': page_starts, 'page_count': page_count}
