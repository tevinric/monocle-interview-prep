"""
Guardrails — deterministic checks, each recorded as a `guardrail` span with its verdict.

input_pii     Scans the question before it is stored or sent to a model. Matches become
              [REDACTED:TYPE]. Only types and counts are recorded — never the values.
groundedness  Every citation must resolve to evidence gathered in THIS run, and its quote
              must appear verbatim in that evidence. Sentences left without a verified
              citation, or flagged unsupported by the model, are stripped from the answer.
abstention    Decided in the loop: below the confidence threshold, or with no verified
              citation, the agent declines and says what it searched.
"""
import re
from dataclasses import dataclass, field


# =============================================================================
# INPUT PII
# =============================================================================
def _luhn(digits):
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _sa_id(value):
    """South African ID number: YYMMDD + 7 digits, Luhn check digit."""
    month, day = int(value[2:4]), int(value[4:6])
    return 1 <= month <= 12 and 1 <= day <= 31 and _luhn(value)


PII_PATTERNS = [
    ('email', re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'), None),
    ('sa_id_number', re.compile(r'(?<!\d)\d{13}(?!\d)'), _sa_id),
    ('payment_card', re.compile(r'(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)'), lambda v: _luhn(re.sub(r'\D', '', v))),
    ('iban', re.compile(r'\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b'), None),
    ('phone', re.compile(r'(?<![\w+])(?:\+\d{1,3}[ -]?)?\(?0?\d{2,3}\)?[ -]?\d{3}[ -]?\d{3,4}(?!\d)'), None),
]


@dataclass
class Screening:
    text: str
    verdict: str
    detail: dict


def scan_pii(text):
    counts = {}
    for kind, pattern, check in PII_PATTERNS:
        def replace(m, kind=kind, check=check):
            if check and not check(m.group(0)):
                return m.group(0)
            counts[kind] = counts.get(kind, 0) + 1
            return f'[REDACTED:{kind.upper()}]'
        text = pattern.sub(replace, text)
    total = sum(counts.values())
    return Screening(
        text=text,
        verdict='redacted' if total else 'pass',
        detail={'types': counts, 'total': total,
                'note': 'Values are never recorded. The redacted question is what was stored and sent to the model.'},
    )


# =============================================================================
# GROUNDEDNESS
# =============================================================================
_FOLD = str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ', '­': None})
MARKER = re.compile(r'\[(E\d+(?:\s*[,;]\s*E\d+)*)\]')
SENTENCE_SPLIT = re.compile(r'(?<=[.!?])\s+(?=[A-Z("“\'])')
LIST_PREFIX = re.compile(r'^(\s*(?:[-*•]|\d+[.)])\s+)')
MIN_QUOTE_CHARS, MIN_QUOTE_WORDS = 20, 4


def _fold_with_index(text):
    out, index, prev_space = [], [], False
    for i, ch in enumerate(text):
        ch = ch.translate(_FOLD)
        if not ch:
            continue
        if ch.isspace():
            if prev_space:
                continue
            ch, prev_space = ' ', True
        else:
            prev_space = False
        out.append(ch.lower())
        index.append(i)
    return ''.join(out), index


def locate_quote(text, quote):
    """(start, end) of the quote in text — exact, else after folding case, quotes, dashes and whitespace."""
    q = quote.strip().strip('"\'“”‘’').strip()
    if not q:
        return None
    pos = text.find(q)
    if pos >= 0:
        return pos, pos + len(q)
    folded, index = _fold_with_index(text)
    fq = _fold_with_index(q)[0].strip().strip('.…').strip()
    pos = folded.find(fq) if fq else -1
    if pos < 0:
        return None
    return index[pos], index[pos + len(fq) - 1] + 1


def _norm(s):
    return _fold_with_index(MARKER.sub('', s))[0].strip(' .')


def _ids(fragment):
    return [i.strip() for group in MARKER.findall(fragment) for i in re.split(r'[,;]', group)]


@dataclass
class Groundedness:
    answer: str
    citations: list
    rejected: list = field(default_factory=list)
    stripped: list = field(default_factory=list)
    verified_ratio: float = 0.0
    factual_sentences: int = 0
    kept_sentences: int = 0

    @property
    def verdict(self):
        if self.kept_sentences == 0:
            return 'fail'
        return 'pass' if not self.rejected and not self.stripped else 'modified'

    def detail(self):
        return {'verdict': self.verdict, 'verified_ratio': self.verified_ratio,
                'citations_verified': len(self.citations), 'citations_rejected': self.rejected,
                'sentences_total': self.factual_sentences, 'sentences_kept': self.kept_sentences,
                'stripped_claims': self.stripped}


def check_groundedness(answer, citations, unsupported_claims, evidence):
    verified, rejected = {}, []
    for c in citations:
        eid = c['evidence_id'].strip().strip('[]')
        ev = evidence.get(eid)
        quote = (c.get('quote') or '').strip()
        reason, loc = None, None
        if ev is None:
            reason = 'evidence id was not gathered in this run'
        elif len(quote) < MIN_QUOTE_CHARS and len(quote.split()) < MIN_QUOTE_WORDS:
            reason = 'quote too short to verify'
        else:
            loc = locate_quote(ev['text'], quote)
            if loc is None:
                reason = 'quote not found verbatim in the evidence'
        if reason:
            rejected.append({'evidence_id': eid, 'quote': quote, 'reason': reason})
            continue
        verified.setdefault(eid, []).append({
            'marker': eid, 'chunk_id': ev['chunk_id'], 'doc_id': ev['doc_id'], 'doc_key': ev['doc_key'],
            'short_name': ev['short_name'], 'section_path': ev['section_path'], 'page_no': ev['page_no'],
            'quote': ev['text'][loc[0]:loc[1]],
            'char_start': ev['char_start'] + loc[0], 'char_end': ev['char_start'] + loc[1],
        })

    unsupported = [_norm(u) for u in unsupported_claims if len(u.strip()) > 12]
    lines, stripped, factual, kept_count = [], [], 0, 0
    for line in (answer or '').split('\n'):
        if not line.strip():
            lines.append('')
            continue
        prefix_match = LIST_PREFIX.match(line)
        prefix = prefix_match.group(1) if prefix_match else ''
        kept = []
        for sentence in SENTENCE_SPLIT.split(line[len(prefix):]):
            plain = MARKER.sub('', sentence).strip()
            if not plain:
                continue
            ids = _ids(sentence)
            if not ids and (plain.endswith(':') or len(plain.split()) <= 6):
                kept.append(sentence)          # headings and lead-ins carry no claim
                continue
            factual += 1
            if any(u and (u in _norm(plain) or _norm(plain) in u) for u in unsupported):
                stripped.append({'sentence': plain, 'reason': 'flagged unsupported by the model'})
                continue
            if not any(i in verified for i in ids):
                stripped.append({'sentence': plain, 'reason': 'no verified citation' if ids else 'no citation'})
                continue

            def keep_verified(m):
                good = [i.strip() for i in re.split(r'[,;]', m.group(1)) if i.strip() in verified]
                return '[' + ', '.join(good) + ']' if good else ''
            kept.append(MARKER.sub(keep_verified, sentence))
            kept_count += 1
        if kept:
            lines.append(prefix + ' '.join(kept))

    cleaned = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip() if kept_count else ''
    used = []
    for marker in dict.fromkeys(_ids(cleaned)):
        used.extend(verified.get(marker, []))
    total = len(citations)
    return Groundedness(
        answer=cleaned, citations=used, rejected=rejected, stripped=stripped,
        verified_ratio=round((total - len(rejected)) / total, 3) if total else 0.0,
        factual_sentences=factual, kept_sentences=kept_count,
    )


# =============================================================================
# ABSTENTION
# =============================================================================
def _describe_search(s):
    a = s['arguments']
    if s['tool'] in ('search_corpus', 'compare_frameworks'):
        scope = ', '.join(a.get('frameworks') or []) or 'all documents'
        what = f"“{a.get('query') or a.get('topic')}” in {scope}"
    elif s['tool'] == 'fetch_section':
        what = f"section “{a['section_path']}” of {a['doc_id']}"
    elif s['tool'] == 'list_obligations':
        what = f"{a['role']} obligations in {a['framework']}"
    else:
        what = 'EU AI Act risk classification'
    outcome = f"{s['evidence']} passages" if s['ok'] else f"failed: {s['error']}"
    return f"- {s['tool']}: {what} → {outcome}"


def abstention_message(reasons, searched, corpus_names):
    lines = ["I can't answer that from the documents I have, so I won't guess.", '',
             'Why: ' + '; '.join(reasons) + '.', '']
    if searched:
        lines.append('What I searched:')
        lines.extend(_describe_search(s) for s in searched)
        lines.append('')
    lines.append('The corpus is limited to: ' + ', '.join(corpus_names) + '.')
    return '\n'.join(lines)
