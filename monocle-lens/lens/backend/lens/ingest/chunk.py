"""
Section-aware chunking: ~800 tokens with 120 overlap, never crossing a top-level section.

Chunks carry character offsets into the document text, so a chunk's text is exactly
text[char_start:char_end] — the property the citation highlighting depends on.
"""
import bisect

import tiktoken

TARGET_TOKENS = 800
OVERLAP_TOKENS = 120
ENCODING = 'cl100k_base'   # the text-embedding-3-* tokenizer


def _page_for(page_starts, position):
    index = bisect.bisect_right([s for s, _ in page_starts], position) - 1
    return page_starts[max(index, 0)][1] if page_starts else None


def chunk_document(parsed, target_tokens=TARGET_TOKENS, overlap_tokens=OVERLAP_TOKENS):
    encoder = tiktoken.get_encoding(ENCODING)
    text, sections = parsed['text'], parsed['sections']
    section_starts = [s['char_start'] for s in sections]

    groups = {}
    for section in sections:
        g = groups.setdefault(section['group'], {'start': section['char_start'], 'end': section['char_end']})
        g['start'] = min(g['start'], section['char_start'])
        g['end'] = max(g['end'], section['char_end'])

    chunks = []
    for _, bounds in sorted(groups.items(), key=lambda kv: kv[1]['start']):
        segment = text[bounds['start']:bounds['end']]
        if not segment.strip():
            continue
        tokens = encoder.encode(segment, disallowed_special=())
        decoded, offsets = encoder.decode_with_offsets(tokens)
        if decoded != segment:           # non-round-tripping text: fall back to even character windows
            offsets = [min(int(i * len(segment) / max(len(tokens), 1)), len(segment)) for i in range(len(tokens))]

        start_token = 0
        while start_token < len(tokens):
            end_token = min(start_token + target_tokens, len(tokens))
            cs = offsets[start_token]
            ce = offsets[end_token] if end_token < len(tokens) else len(segment)
            if end_token < len(tokens):          # prefer a paragraph or sentence boundary near the end
                tail_from = int((ce - cs) * 0.8)
                window = segment[cs:ce]
                cut = max(window.rfind('\n', tail_from), window.rfind('. ', tail_from))
                if cut > 0:
                    ce = cs + cut + 1
            absolute_start, absolute_end = bounds['start'] + cs, bounds['start'] + ce
            while absolute_start < absolute_end and text[absolute_start].isspace():
                absolute_start += 1
            while absolute_end > absolute_start and text[absolute_end - 1].isspace():
                absolute_end -= 1
            body = text[absolute_start:absolute_end]
            if body.strip():
                index = max(bisect.bisect_right(section_starts, absolute_start) - 1, 0)
                chunks.append({
                    'section_path': sections[index]['section_path'],
                    'section_index': index,
                    'page_no': _page_for(parsed['page_starts'], absolute_start),
                    'char_start': absolute_start,
                    'char_end': absolute_end,
                    'text': body,
                    'tokens': len(encoder.encode(body, disallowed_special=())),
                })
            if end_token >= len(tokens):
                break
            snapped = bisect.bisect_left(offsets, ce)
            start_token = max(snapped - overlap_tokens, start_token + 1)

    for i, chunk in enumerate(chunks):
        chunk['ordinal'] = i
    return chunks
