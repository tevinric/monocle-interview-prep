"""
Optional OpenTelemetry export — enabled by setting LENS_OTLP_ENDPOINT.

After a run finishes, its spans are re-emitted from PostgreSQL using the OpenTelemetry
GenAI semantic conventions (gen_ai.*), keeping Lens's trace id. PostgreSQL remains the
system of record; the export runs on a background thread and a failure is logged, never
surfaced to the user or allowed to affect the run.
"""
import logging
import threading

from lens.db import db_cursor

logger = logging.getLogger(__name__)


def export_run_async(run_id, endpoint):
    threading.Thread(target=_export, args=(str(run_id), endpoint), daemon=True).start()


def _ns(ts):
    return int(ts.timestamp() * 1_000_000_000)


def _attributes(span, run):
    a = span['attributes_json'] or {}
    out = span['output_json'] or {}
    common = {
        'lens.run_id': str(run['id']),
        'lens.span_id': str(span['id']),
        'lens.span.type': span['type'],
        'lens.prompt_version': a.get('prompt_version') or '',
    }
    if span['type'] == 'llm':
        operation = 'embeddings' if span['name'].endswith('embed') else 'chat'
        attrs = {
            'gen_ai.operation.name': operation,
            'gen_ai.system': 'openai',
            'gen_ai.provider.name': 'openai',
            'gen_ai.request.model': a.get('model') or '',
            'gen_ai.usage.input_tokens': int(a.get('input_tokens') or 0),
            'gen_ai.usage.output_tokens': int(a.get('output_tokens') or 0),
        }
        if operation == 'chat':
            # Reasoning models send neither temperature nor max_tokens; report what was sent.
            if a.get('temperature') is not None:
                attrs['gen_ai.request.temperature'] = float(a['temperature'])
            for source, target in (('max_tokens', 'gen_ai.request.max_tokens'),
                                   ('max_completion_tokens', 'gen_ai.request.max_tokens'),
                                   ('reasoning_effort', 'gen_ai.request.reasoning_effort')):
                if a.get(source) is not None:
                    attrs[target] = a[source] if source == 'reasoning_effort' else int(a[source])
            if out.get('model'):
                attrs['gen_ai.response.model'] = out['model']
            if out.get('id'):
                attrs['gen_ai.response.id'] = out['id']
            if out.get('finish_reason'):
                attrs['gen_ai.response.finish_reasons'] = [out['finish_reason']]
        return f"{operation} {a.get('model', '')}".strip(), {**common, **attrs}
    if span['type'] == 'tool':
        tool = a.get('tool_name', span['name'])
        return f'execute_tool {tool}', {**common, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool}
    if span['type'] == 'agent' and span['parent_span_id'] is None:
        return 'invoke_agent lens', {**common, 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'lens'}
    return span['name'], common


def _export(run_id, endpoint):
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.id_generator import RandomIdGenerator
        from opentelemetry.trace import SpanKind, Status, StatusCode, set_span_in_context

        with db_cursor() as cur:
            cur.execute('SELECT * FROM runs WHERE id = %s', (run_id,))
            run = cur.fetchone()
            cur.execute('SELECT * FROM spans WHERE run_id = %s ORDER BY sequence', (run_id,))
            spans = cur.fetchall()
        if not run or not spans:
            return

        class LensTraceId(RandomIdGenerator):
            def generate_trace_id(self):
                return int(run['trace_id'], 16)

        provider = TracerProvider(
            resource=Resource.create({'service.name': 'lens-backend'}),
            id_generator=LensTraceId(),
        )
        provider.add_span_processor(
            SimpleSpanProcessor(OTLPSpanExporter(endpoint=endpoint.rstrip('/') + '/v1/traces', timeout=10))
        )
        tracer = provider.get_tracer('lens')

        started = {}
        for s in spans:
            parent = started.get(s['parent_span_id'])
            name, attributes = _attributes(s, run)
            otel_span = tracer.start_span(
                name,
                context=set_span_in_context(parent) if parent else None,
                kind=SpanKind.CLIENT if s['type'] == 'llm' else SpanKind.INTERNAL,
                start_time=_ns(s['started_at']),
                attributes=attributes,
            )
            if s['status'] == 'error':
                otel_span.set_status(Status(StatusCode.ERROR, s['error'] or ''))
            started[s['id']] = otel_span
        for s in reversed(spans):
            started[s['id']].end(end_time=_ns(s['ended_at'] or s['started_at']))
        provider.shutdown()
        # The exporter reports delivery failures on its own logger; this only records that
        # the run was handed to it.
        logger.info(f'Emitted run {run_id} ({len(spans)} spans) to {endpoint}')
    except Exception as e:
        logger.error(f'OTLP export failed for run {run_id}: {e}')
