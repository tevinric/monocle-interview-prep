"""
Download a source document and record its provenance.

A failed or unexpected download is NEVER papered over: the document is marked
`unavailable` with the reason, shows as such in /corpus, and the agent is told it cannot
search it. Nothing is ever fabricated to fill the gap.
"""
import hashlib
import os
from datetime import datetime, timezone

import requests

USER_AGENT = 'Mozilla/5.0 (compatible; Lens-ingest/1.0; regulatory RAG demonstration)'
TIMEOUT = (15, 180)

# Sent on every request. Most publishers serve one file per URL and ignore it, but the EU
# Publications Office (CELLAR, which serves the AI Act) negotiates BOTH format and
# language: with no Accept-Language it answers a PDF request with RDF metadata about the
# act instead of the act. 'eng' is the three-letter form its vocabulary uses; it also
# accepts 'en'. Verified harmless against the other five sources.
REQUEST_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/pdf,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'eng',
}


class Fetched:
    def __init__(self, status, path=None, sha256=None, bytes_=None, content_type=None,
                 retrieved_at=None, detail=None):
        self.status = status                  # ok | unavailable
        self.path = path
        self.sha256 = sha256
        self.bytes = bytes_
        self.content_type = content_type
        self.retrieved_at = retrieved_at
        self.detail = detail


def _describe(path, detail):
    with open(path, 'rb') as f:
        body = f.read()
    return Fetched('ok', path=path, sha256=hashlib.sha256(body).hexdigest(), bytes_=len(body),
                   content_type='application/pdf' if body.startswith(b'%PDF-') else 'text/html',
                   retrieved_at=datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc), detail=detail)


def _cached(raw_dir, key):
    for ext in ('pdf', 'html'):
        path = os.path.join(raw_dir, f'{key}.{ext}')
        if os.path.exists(path):
            return path
    return None


def fetch(doc, raw_dir, offline=False):
    os.makedirs(raw_dir, exist_ok=True)
    expected = doc.get('format', 'pdf')
    cached = _cached(raw_dir, doc['key'])

    if offline:
        if not cached:
            return Fetched('unavailable', detail='offline ingest and no cached copy in corpus/raw')
        return _describe(cached, 'cached copy (offline ingest); retrieved_at is the file timestamp')

    try:
        response = requests.get(doc['source_url'], headers=REQUEST_HEADERS,
                                timeout=TIMEOUT, allow_redirects=True)
    except requests.RequestException as e:
        return Fetched('unavailable', detail=f'download failed: {e.__class__.__name__}: {e}')

    if response.status_code != 200:
        # A bare status code is a poor explanation when the status is the publisher's bot
        # protection rather than a missing file — an AWS WAF challenge arrives as a 202
        # with an empty body, which reads like a server fault and is not one. Name it, so
        # the fix (a machine-access endpoint for the same document) is the obvious one.
        challenge = response.headers.get('x-amzn-waf-action') or response.headers.get('cf-mitigated')
        reason = (f'HTTP {response.status_code} from {response.url}')
        if challenge:
            reason += (f' — the publisher answered with a bot challenge ({challenge}), not the document. '
                       'This URL needs a browser; use the publisher\'s machine-access endpoint instead.')
        return Fetched('unavailable', detail=reason)

    body = response.content
    declared = (response.headers.get('Content-Type') or '').split(';')[0].strip().lower()
    if body.startswith(b'%PDF-'):
        kind = 'pdf'
    elif 'html' in declared or body[:200].lstrip().lower().startswith((b'<!doctype html', b'<html')):
        kind = 'html'
    else:
        return Fetched('unavailable', detail=f'unexpected content ({declared or "unknown type"}, {len(body)} bytes)')
    if kind != expected:
        return Fetched('unavailable',
                       detail=f'expected {expected} but the publisher returned {kind} — the file has probably moved')

    path = os.path.join(raw_dir, f"{doc['key']}.{kind}")
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        f.write(body)
    os.replace(tmp, path)
    return Fetched('ok', path=path, sha256=hashlib.sha256(body).hexdigest(), bytes_=len(body),
                   content_type=declared or kind, retrieved_at=datetime.now(timezone.utc),
                   detail=f'downloaded from {response.url}')
