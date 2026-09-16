"""HTML parsing with selectolax — same output shape as parse_pdf (no corpus source uses it yet)."""
import re

from selectolax.parser import HTMLParser

HEADINGS = {'h1': 1, 'h2': 2, 'h3': 3, 'h4': 3}


def parse_html(path, doc_meta):
    with open(path, encoding='utf-8', errors='replace') as f:
        tree = HTMLParser(f.read())
    for tag in ('script', 'style', 'nav', 'footer', 'header', 'noscript'):
        for node in tree.css(tag):
            node.decompose()

    short_name = doc_meta.get('short_name') or doc_meta['key']
    parts, records, length = [], [], 0
    for node in tree.css('h1, h2, h3, h4, p, li, td'):
        content = re.sub(r'\s+', ' ', node.text(separator=' ')).strip()
        if not content:
            continue
        if parts:
            parts.append('\n\n')
            length += 2
        start = length
        parts.append(content)
        length += len(content)
        records.append({'start': start, 'end': length, 'page_no': 1, 'level': HEADINGS.get(node.tag),
                        'segment': content[:120] if node.tag in HEADINGS else None})
    text = ''.join(parts)

    sections, stack, current, group = [], [], None, 0

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
        current = {'section_path': ' > '.join([short_name] + [s for _, s in stack]), 'heading': record['segment'],
                   'level': record['level'], 'page_start': 1, 'char_start': record['start'], 'group': max(group, 1)}
    close(len(text))
    if not sections or sections[0]['char_start'] > 0:
        end = sections[0]['char_start'] if sections else len(text)
        sections.insert(0, {'section_path': f'{short_name} > Front matter', 'heading': 'Front matter', 'level': 1,
                            'page_start': 1, 'char_start': 0, 'char_end': end, 'text': text[:end], 'group': 0})
    for i, section in enumerate(sections):
        section['ordinal'] = i
        section['page_end'] = 1
    return {'text': text, 'sections': sections, 'page_starts': [(0, 1)], 'page_count': 1}
