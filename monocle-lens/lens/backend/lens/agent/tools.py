"""
The agent's five tools.

Each tool has a strict JSON schema — the contract the planner's output must satisfy —
and a plain Python implementation. Arguments and results are persisted verbatim on the
tool span (`tool_calls`). Tools return evidence as chunk records; the loop assigns the
evidence ids (E1, E2, ...) that answers cite.

A tool failure never crashes the run: it is recorded as an error span and handed back to
the planner, which can try something else.
"""
import re
import threading
import time

from lens.agent import ai_act
from lens.corpus import framework_keys, load_manifest
from lens.db import db_cursor
from lens.retrieval.hybrid import hybrid_search, retrieval_parameters

FRAMEWORKS = framework_keys()
ROLES = ['second_line', 'model_owner', 'provider', 'deployer']
SECTORS = ['banking', 'insurance', 'employment', 'education', 'healthcare', 'law_enforcement',
           'public_sector', 'critical_infrastructure', 'other']


def _object(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


TOOL_SCHEMAS = {
    'search_corpus': {
        'description': 'Hybrid (vector + keyword) search over the regulatory corpus. Returns ranked chunks with document, section path, score and text.',
        'parameters': _object({
            'query': {'type': 'string', 'description': 'Search query, in the vocabulary of the regulation.'},
            'frameworks': {'type': ['array', 'null'], 'items': {'type': 'string', 'enum': FRAMEWORKS},
                           'description': 'Restrict to these document keys, or null to search everything.'},
            'top_k': {'type': 'integer', 'description': 'Number of results, normally 8 (maximum 12).'},
        }),
    },
    'fetch_section': {
        'description': 'Full text of one section, for when a chunk is cut off mid-obligation.',
        'parameters': _object({
            'doc_id': {'type': 'string', 'enum': FRAMEWORKS, 'description': 'Document key, e.g. ss123.'},
            'section_path': {'type': 'string', 'description': 'Section path exactly as shown on the evidence.'},
        }),
    },
    'compare_frameworks': {
        'description': 'Retrieve evidence on one topic from each of two or more frameworks, grouped by framework.',
        'parameters': _object({
            'topic': {'type': 'string', 'description': 'The topic to compare, in regulatory vocabulary.'},
            'frameworks': {'type': 'array', 'items': {'type': 'string', 'enum': FRAMEWORKS},
                           'description': 'Two to four document keys.'},
        }),
    },
    'classify_ai_act_risk': {
        'description': 'Deterministic EU AI Act risk tiering (a decision table, not a model). Returns tier, rationale, obligations and article references.',
        'parameters': _object({
            'system_description': {'type': 'string', 'description': 'What the AI system does and who it affects.'},
            'sector': {'type': 'string', 'enum': SECTORS},
            'uses_biometrics': {'type': 'boolean'},
            'affects_credit_or_employment': {'type': 'boolean',
                                             'description': 'True if it evaluates or decides credit or employment for natural persons.'},
        }),
    },
    'list_obligations': {
        'description': 'Retrieve the provisions setting out obligations for a role under one framework, each cited.',
        'parameters': _object({
            'framework': {'type': 'string', 'enum': FRAMEWORKS},
            'role': {'type': 'string', 'enum': ROLES},
        }),
    },
}


def openai_tools():
    """The same contracts as OpenAI function tools (strict), for export and inspection."""
    return [{'type': 'function', 'function': {'name': n, 'description': s['description'],
                                              'parameters': s['parameters'], 'strict': True}}
            for n, s in TOOL_SCHEMAS.items()]


def plan_schema():
    variants = [
        {'type': 'object',
         'properties': {'tool': {'type': 'string', 'enum': [name]}, 'arguments': spec['parameters']},
         'required': ['tool', 'arguments'], 'additionalProperties': False}
        for name, spec in TOOL_SCHEMAS.items()
    ]
    return _object({
        'intent': {'type': 'string', 'description': 'What the user needs, in one sentence.'},
        'frameworks': {'type': 'array', 'items': {'type': 'string', 'enum': FRAMEWORKS}},
        'evidence_sufficient': {'type': 'boolean'},
        'tool_calls': {'type': 'array', 'items': {'anyOf': variants}},
    })


# =============================================================================
# EXECUTION
# =============================================================================
class ToolError(RuntimeError):
    pass


class ToolContext:
    def __init__(self, tracer, llm, fault_injection=None):
        self.tracer = tracer
        self.llm = llm
        self.fault_injection = fault_injection or None
        self._counts = {}
        self._lock = threading.Lock()

    def count(self, tool):
        with self._lock:
            self._counts[tool] = self._counts.get(tool, 0) + 1
            return self._counts[tool]


def _validate(schema, value, path='arguments'):
    t = schema.get('type')
    types = t if isinstance(t, list) else [t]
    checks = {'string': lambda v: isinstance(v, str), 'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
              'boolean': lambda v: isinstance(v, bool), 'array': lambda v: isinstance(v, list),
              'object': lambda v: isinstance(v, dict), 'null': lambda v: v is None, 'number': lambda v: isinstance(v, (int, float))}
    if not any(checks[x](value) for x in types):
        raise ToolError(f'{path} must be {" or ".join(types)}')
    if value is None:
        return
    if 'enum' in schema and value not in schema['enum']:
        raise ToolError(f'{path}={value!r} is not one of {schema["enum"]}')
    if isinstance(value, dict):
        missing = [k for k in schema.get('required', []) if k not in value]
        extra = [k for k in value if k not in schema.get('properties', {})]
        if missing or extra:
            raise ToolError(f'{path}: missing {missing} unexpected {extra}')
        for k, v in value.items():
            _validate(schema['properties'][k], v, f'{path}.{k}')
    if isinstance(value, list) and 'items' in schema:
        for i, v in enumerate(value):
            _validate(schema['items'], v, f'{path}[{i}]')


def run_tool(ctx, name, arguments, parent):
    with ctx.tracer.span(f'tool.{name}', type='tool', parent=parent, input=arguments,
                         attributes={'tool_name': name}) as span:
        started = time.perf_counter()
        result, ok, error = None, True, None
        try:
            if name not in IMPLEMENTATIONS:
                raise ToolError(f'unknown tool {name}')
            _validate(TOOL_SCHEMAS[name]['parameters'], arguments)
            occurrence = ctx.count(name)
            fault = ctx.fault_injection
            if fault and fault.get('tool') == name and fault.get('occurrence', 1) == occurrence:
                span.set_attributes(fault_injected=True)
                raise ToolError(fault.get('error', 'Injected fault'))
            result = IMPLEMENTATIONS[name](ctx, span, **arguments)
        except Exception as e:
            ok, error = False, f'{e.__class__.__name__}: {e}'
            span.fail(error)
        duration_ms = int((time.perf_counter() - started) * 1000)
        span.set_output({'ok': ok, 'error': error, 'evidence': len((result or {}).get('evidence', []))})
        ctx.tracer.record_tool_call(span, name, arguments, result, ok, error, duration_ms)
        return {'tool': name, 'arguments': arguments, 'ok': ok, 'error': error, 'result': result, 'span_id': span.id}


def summarise_result(r):
    """Compact form for the live stream."""
    out = {'tool': r['tool'], 'arguments': r['arguments'], 'ok': r['ok'], 'error': r['error'],
           'evidence': len((r['result'] or {}).get('evidence', []))}
    if r['ok'] and r['result'].get('deterministic'):
        out['tier'] = r['result']['tier']
    return out


def _evidence(row):
    return {k: (str(row[k]) if k in ('chunk_id', 'doc_id') else row.get(k))
            for k in ('chunk_id', 'doc_id', 'doc_key', 'short_name', 'section_path', 'page_no',
                      'char_start', 'char_end', 'text')}


def retrieve(ctx, parent, query, doc_keys, top_k, name='retrieval.hybrid'):
    """Embed the query and run hybrid search; every candidate persisted on a retrieval span."""
    with ctx.tracer.span(name, type='retrieval', parent=parent,
                         input={'query': query, 'frameworks': doc_keys, 'top_k': top_k},
                         attributes=retrieval_parameters(top_k)) as span:
        vector = ctx.llm.embed([query], tracer=ctx.tracer, parent=span)[0]
        results = hybrid_search(query, vector, doc_keys, top_k)
        ctx.tracer.record_retrieved(span, results['fused'] + results['dense'] + results['keyword'])
        fused = results['fused']
        span.set_output({
            'n_fused': len(fused), 'n_dense': len(results['dense']), 'n_keyword': len(results['keyword']),
            'top_score': fused[0]['score'] if fused else None,
            'fused': [{k: c[k] for k in ('rank', 'score', 'dense_rank', 'keyword_rank', 'doc_key', 'section_path')}
                      for c in fused],
        })
        return [_evidence(c) for c in fused]


def _record_lookup(ctx, parent, name, retriever, rows, input_):
    with ctx.tracer.span(name, type='retrieval', parent=parent, input=input_,
                         attributes={'retriever': retriever}) as span:
        ctx.tracer.record_retrieved(span, [
            {'chunk_id': r['chunk_id'], 'doc_id': r['doc_id'], 'section_path': r['section_path'],
             'rank': i + 1, 'score': None, 'retriever': retriever} for i, r in enumerate(rows)])
        span.set_output({'n': len(rows), 'sections': sorted({r['section_path'] for r in rows})})


CHUNK_COLUMNS = """c.id AS chunk_id, c.doc_id, d.key AS doc_key, d.short_name, c.section_path, c.page_no,
                   c.char_start, c.char_end, c.ordinal, c.text"""


# ── search_corpus ────────────────────────────────────────────────────────────
def search_corpus(ctx, span, query, frameworks, top_k):
    top_k = max(1, min(int(top_k), 12))
    return {'query': query, 'frameworks': frameworks, 'evidence': retrieve(ctx, span, query, frameworks, top_k)}


# ── fetch_section ────────────────────────────────────────────────────────────
MAX_SECTION_CHUNKS = 12


def fetch_section(ctx, span, doc_id, section_path):
    escaped = section_path.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    last = section_path.split(' > ')[-1].strip()
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT s.section_path, s.char_start, s.char_end, s.doc_id
              FROM sections s JOIN documents d ON d.id = s.doc_id
             WHERE d.key = %s AND s.active
               AND (s.section_path = %s OR s.section_path LIKE %s ESCAPE '\\')
             ORDER BY s.ordinal
            """,
            (doc_id, section_path, escaped + ' > %'),
        )
        rows = cur.fetchall()
        match = 'exact'
        if not rows and last:
            cur.execute(
                """
                SELECT s.section_path, s.char_start, s.char_end, s.doc_id
                  FROM sections s JOIN documents d ON d.id = s.doc_id
                 WHERE d.key = %s AND s.active AND lower(s.section_path) LIKE lower(%s) ESCAPE '\\'
                 ORDER BY s.ordinal LIMIT 1
                """,
                (doc_id, '% > ' + last.replace('%', '\\%').replace('_', '\\_') + '%'),
            )
            rows = cur.fetchall()
            match = 'by final path segment'
        if not rows:
            raise ToolError(f'No section {section_path!r} in {doc_id}. Use a section path exactly as shown on evidence.')
        start, end = min(r['char_start'] for r in rows), max(r['char_end'] for r in rows)
        cur.execute(
            f"""
            SELECT {CHUNK_COLUMNS}
              FROM chunks c JOIN documents d ON d.id = c.doc_id
             WHERE c.doc_id = %s AND c.active AND c.char_start < %s AND c.char_end > %s
             ORDER BY c.ordinal LIMIT %s
            """,
            (rows[0]['doc_id'], end, start, MAX_SECTION_CHUNKS + 1),
        )
        chunks = cur.fetchall()
    truncated = len(chunks) > MAX_SECTION_CHUNKS
    chunks = chunks[:MAX_SECTION_CHUNKS]
    _record_lookup(ctx, span, 'retrieval.section', 'section', chunks,
                   {'doc_id': doc_id, 'section_path': section_path, 'match': match})
    return {'doc_id': doc_id, 'section_path': rows[0]['section_path'], 'match': match,
            'truncated': truncated, 'evidence': [_evidence(c) for c in chunks]}


# ── compare_frameworks ───────────────────────────────────────────────────────
def compare_frameworks(ctx, span, topic, frameworks):
    keys = list(dict.fromkeys(frameworks))[:4]
    if len(keys) < 2:
        raise ToolError('compare_frameworks needs at least two different frameworks')
    groups, evidence = [], []
    for key in keys:      # sequential on purpose: a stable span order reads better in the waterfall
        found = retrieve(ctx, span, topic, [key], 4, name=f'retrieval.hybrid.{key}')
        groups.append({'framework': key, 'chunk_ids': [c['chunk_id'] for c in found]})
        evidence.extend(found)
    return {'topic': topic, 'by_framework': groups, 'evidence': evidence}


# ── classify_ai_act_risk ─────────────────────────────────────────────────────
def classify_ai_act_risk(ctx, span, system_description, sector, uses_biometrics, affects_credit_or_employment):
    result = ai_act.classify(system_description, sector, uses_biometrics, affects_credit_or_employment)
    span.set_attributes(deterministic=True, table_version=result['table_version'], tier=result['tier'])
    # Resolve every article reference to the Act's own text, so the answer can cite it.
    rows, unresolved = [], []
    with db_cursor() as cur:
        for ref in result['article_refs']:
            if ref == 'Annex III':
                cur.execute(
                    f"""
                    SELECT {CHUNK_COLUMNS}
                      FROM chunks c JOIN documents d ON d.id = c.doc_id
                     WHERE d.key = 'euaiact' AND c.active AND c.section_path ~* %s
                       AND (%s::text[] IS NULL OR c.text ILIKE ANY(%s::text[]))
                     ORDER BY c.ordinal LIMIT 2
                    """,
                    (r'(^| > )ANNEX III( |$)', result['annex_hints'] or None,
                     ['%' + h + '%' for h in result['annex_hints']] or None),
                )
            else:
                cur.execute(
                    f"""
                    SELECT {CHUNK_COLUMNS}
                      FROM chunks c JOIN documents d ON d.id = c.doc_id
                     WHERE d.key = 'euaiact' AND c.active AND c.section_path ~ %s
                     ORDER BY c.ordinal LIMIT 1
                    """,
                    (r'(^| > )' + re.escape(ref).replace('\\ ', ' ') + r'($| )',),
                )
            found = cur.fetchall()
            if not found:
                unresolved.append(ref)
            rows.extend(r for r in found if r['chunk_id'] not in {x['chunk_id'] for x in rows})
    _record_lookup(ctx, span, 'retrieval.article_lookup', 'lookup', rows,
                   {'article_refs': result['article_refs'], 'annex_hints': result['annex_hints']})
    result['unresolved_refs'] = unresolved
    result['evidence'] = [_evidence(r) for r in rows]
    return result


# ── list_obligations ─────────────────────────────────────────────────────────
ROLE_QUERIES = {
    'second_line': 'independent validation review and effective challenge of models by the risk management function',
    'model_owner': 'model owner responsibilities for model development, implementation, use, documentation and monitoring',
    'provider': 'obligations of providers: risk management, technical documentation, conformity assessment, post-market monitoring',
    'deployer': 'obligations of deployers: use in accordance with instructions, human oversight, monitoring, logs, informing affected persons',
}
# POPIA's vocabulary differs: a "responsible party" decides, an "operator" processes on its behalf.
FRAMEWORK_ROLE_QUERIES = {
    ('popia', 'provider'): 'conditions a responsible party must comply with for lawful processing of personal information',
    ('popia', 'deployer'): 'operator processing personal information on behalf of a responsible party: security measures and written contract',
    ('popia', 'model_owner'): 'responsible party accountability and processing limitation for personal information',
    ('popia', 'second_line'): 'information officer duties and compliance monitoring',
}


def list_obligations(ctx, span, framework, role):
    query = FRAMEWORK_ROLE_QUERIES.get((framework, role), ROLE_QUERIES[role])
    span.set_attributes(query_template=f'{framework}:{role}')
    return {'framework': framework, 'role': role, 'query_used': query,
            'note': 'Provisions retrieved for this role; each item is cited to its source text.',
            'evidence': retrieve(ctx, span, query, [framework], 8)}


IMPLEMENTATIONS = {
    'search_corpus': search_corpus,
    'fetch_section': fetch_section,
    'compare_frameworks': compare_frameworks,
    'classify_ai_act_risk': classify_ai_act_risk,
    'list_obligations': list_obligations,
}


def corpus_listing():
    """The corpus as the planner sees it — including anything unavailable."""
    with db_cursor() as cur:
        cur.execute('SELECT key, status FROM documents')
        status = {r['key']: r['status'] for r in cur.fetchall()}
    lines = []
    for d in load_manifest():
        s = status.get(d['key'], 'not ingested')
        flag = '' if s == 'ok' else f'  [{s.upper()} — cannot be searched]'
        lines.append(f"- {d['key']}: {d['short_name']} — {d['title']} ({d['publisher']}; {d['version']}){flag}")
    return '\n'.join(lines)
