"""
The evidence book.

Tool results arrive as chunk records; each new chunk gets a stable handle (E1, E2, ...)
in the order the planner asked for it. The model only ever sees handles — never database
ids — which is what lets a recorded demo replay against a freshly ingested database.
"""
import json

MAX_EVIDENCE = 30
PREVIEW_CHARS = 280


class EvidenceBook:
    def __init__(self):
        self.items = {}            # 'E1' -> evidence record
        self._seen = set()         # chunk ids already given a handle
        self.notes = []            # deterministic tool results and tool failures
        self.searched = []         # what was searched, for the trace and for abstentions
        self.truncated = False

    def add(self, tool_result):
        self.searched.append({
            'tool': tool_result['tool'], 'arguments': tool_result['arguments'], 'ok': tool_result['ok'],
            'error': tool_result['error'], 'evidence': len((tool_result['result'] or {}).get('evidence', [])),
        })
        if not tool_result['ok']:
            self.notes.append(f"TOOL ERROR — {tool_result['tool']}: {tool_result['error']}")
            return
        result = tool_result['result']
        if result.get('deterministic'):
            self.notes.append(
                'DETERMINISTIC TOOL RESULT — ' + tool_result['tool'] + ': ' + json.dumps(
                    {k: result[k] for k in ('tier', 'rationale', 'obligations', 'considerations',
                                            'article_refs', 'table_version') if k in result},
                    ensure_ascii=False))
        for chunk in result.get('evidence', []):
            self._add(chunk)

    def _add(self, chunk):
        if chunk['chunk_id'] in self._seen:
            return
        if len(self.items) >= MAX_EVIDENCE:
            self.truncated = True
            return
        self._seen.add(chunk['chunk_id'])
        self.items[f'E{len(self.items) + 1}'] = chunk

    def _label(self, handle):
        item = self.items[handle]
        page = f", p. {item['page_no']}" if item.get('page_no') else ''
        return f"[{handle}] {item['short_name']} — {item['section_path']}{page}"

    def planner_view(self):
        if not self.items and not self.notes:
            return '(nothing gathered yet)'
        lines = [f'Evidence gathered ({len(self.items)} passages):']
        for handle in self.items:
            preview = ' '.join(self.items[handle]['text'].split())[:PREVIEW_CHARS]
            lines.append(f'{self._label(handle)}: {preview}…')
        if self.notes:
            lines += ['', 'Notes:'] + self.notes
        if self.searched:
            lines += ['', 'Already searched:'] + [
                f"- {s['tool']} {json.dumps(s['arguments'], ensure_ascii=False)} → "
                + (f"{s['evidence']} passages" if s['ok'] else f"ERROR {s['error']}")
                for s in self.searched]
        return '\n'.join(lines)

    def synthesiser_view(self):
        blocks = []
        for handle in self.items:
            blocks.append(f"{self._label(handle)}\n{self.items[handle]['text'].strip()}")
        if self.notes:
            blocks.append('\n'.join(self.notes))
        if self.truncated:
            blocks.append(f'(evidence limited to the first {MAX_EVIDENCE} passages)')
        return '\n\n'.join(blocks) if blocks else '(no evidence)'
