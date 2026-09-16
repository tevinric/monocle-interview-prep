"""
Versioned prompts.

Prompt files live in agent/prompts/*.md. Each is hashed (SHA-256, first 8 hex chars) and
recorded in `prompt_versions`; every run stores the version of the prompt bundle it used,
and every LLM span stores the hash of the individual prompt. You can therefore prove
which prompt produced which answer.

Files are re-read at the start of every run (they are small), so editing a prompt and
pressing Replay uses the new version with no restart — and gets a new hash.
"""
import hashlib
import json
import os
from dataclasses import dataclass

PROMPT_DIR = os.path.join(os.path.dirname(__file__), 'prompts')
AGENT_PROMPTS = ('planner', 'synthesiser')


def sha8(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:8]


@dataclass(frozen=True)
class Prompt:
    name: str
    hash: str
    template: str

    def render(self, **values):
        text = self.template
        for key, value in values.items():
            text = text.replace('{{' + key + '}}', str(value))
        return text


def load_prompt(name):
    with open(os.path.join(PROMPT_DIR, f'{name}.md'), encoding='utf-8') as f:
        template = f.read()
    return Prompt(name=name, hash=sha8(template), template=template)


def load_bundle(names=AGENT_PROMPTS):
    prompts = {name: load_prompt(name) for name in names}
    bundle_hash = sha8(json.dumps({n: p.hash for n, p in sorted(prompts.items())}, sort_keys=True))
    return prompts, bundle_hash


def _upsert(cur, name, hash_, content):
    cur.execute(
        """
        INSERT INTO prompt_versions (name, hash, content) VALUES (%s, %s, %s)
        ON CONFLICT (name, hash) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        """,
        (name, hash_, content),
    )
    return str(cur.fetchone()['id'])


def register_bundle(cur, prompts, bundle_hash):
    """Record each prompt and the bundle; returns the bundle's prompt_versions id."""
    for p in prompts.values():
        _upsert(cur, p.name, p.hash, p.template)
    content = json.dumps({n: {'hash': p.hash} for n, p in sorted(prompts.items())}, indent=1)
    return _upsert(cur, 'agent', bundle_hash, content)
