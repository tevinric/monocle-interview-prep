"""The corpus manifest (corpus/corpus.yaml) — the single list of documents Lens may know."""
import os
from functools import lru_cache

import yaml

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# In the container the repo's corpus/ is bind-mounted at /app/corpus; running from a
# checkout it sits one level above backend/.
CORPUS_DIR = next(
    (p for p in (os.path.join(_BACKEND_DIR, 'corpus'), os.path.join(os.path.dirname(_BACKEND_DIR), 'corpus'))
     if os.path.exists(os.path.join(p, 'corpus.yaml'))),
    os.path.join(_BACKEND_DIR, 'corpus'),
)
RAW_DIR = os.path.join(CORPUS_DIR, 'raw')


@lru_cache(maxsize=1)
def load_manifest():
    with open(os.path.join(CORPUS_DIR, 'corpus.yaml'), encoding='utf-8') as f:
        documents = yaml.safe_load(f)['documents']
    keys = [d['key'] for d in documents]
    if len(keys) != len(set(keys)):
        raise ValueError('corpus.yaml has duplicate document keys')
    return documents


def framework_keys():
    return [d['key'] for d in load_manifest()]


def manifest_by_key():
    return {d['key']: d for d in load_manifest()}
