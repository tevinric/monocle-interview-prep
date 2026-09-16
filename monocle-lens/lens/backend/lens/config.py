"""
Lens configuration — read once, validated loudly, snapshotted with every run.

Two sources, kept deliberately separate:

  credentials    Azure Key Vault. keyvault-init writes them to /secrets/backend.env and
                 backend/entrypoint.sh sources that file before gunicorn starts. The only
                 credential Lens has is the OpenAI API key.
  configuration  Committed defaults in docker-compose.yml (model names, prices,
                 thresholds, flags) so every change is visible in git history.

A missing or malformed value stops the process with a message naming the variable and
where it is supposed to come from. `Settings.snapshot()` is the non-secret view stored
on every run, so any answer can be tied to the configuration that produced it.

`LENS_ENV_TYPE` is the one switch that changes who may call the API at all: PROD requires
an Entra access token on every request, DEV bypasses sign-in so the stack runs on a laptop
with no tenant. PROD refuses to start without the Entra identifiers, so there is no state
in which the application believes it is enforcing sign-in and is not.
"""
import hashlib
import json
from dataclasses import dataclass, field
from functools import lru_cache
import os

# Must match vector(1536) in database/sql_init.sql. text-embedding-3-small is native at
# 1536; changing model or size means changing the column in BOTH schema copies.
SCHEMA_EMBEDDING_DIMENSIONS = 1536

# Reasoning models (gpt-5*, gpt-6*, o*) take max_completion_tokens and reasoning_effort,
# and reject temperature. Everything else takes max_tokens and temperature.
REASONING_MODEL_PREFIXES = ('gpt-5', 'gpt-6', 'o1', 'o3', 'o4')
# The values the API accepts today. 'minimal' and 'max' were withdrawn — sending either
# now returns 400 unsupported_value, so they are rejected here at startup instead of
# halfway through a run. If you pin an older snapshot that still takes 'minimal', add it
# back to this tuple; the API remains the authority and llm.py reports what it says.
REASONING_EFFORTS = ('none', 'low', 'medium', 'high', 'xhigh')
DEFAULT_REASONING_EFFORT = 'low'

# On a reasoning model max_completion_tokens is a budget for reasoning AND the visible
# answer, so it has to be far larger than a plain output cap or the answer is truncated
# with finish_reason=length before it is finished.
DEFAULT_MAX_TOKENS_REASONING = 8000
DEFAULT_MAX_TOKENS_STANDARD = 2000

FROM_VAULT = 'Azure Key Vault (keyvault/fetch_secrets.py SECRET_MAP)'
FROM_COMPOSE = 'docker-compose.yml (backend environment)'

# PROD enforces Entra sign-in; DEV bypasses it. Nothing else is accepted — a typo in this
# variable must not be able to quietly turn authentication off.
ENV_TYPES = ('DEV', 'PROD')
DEFAULT_ENTRA_SCOPE = 'Lens.Access'


class ConfigError(RuntimeError):
    pass


def is_reasoning_model(model):
    return str(model or '').lower().startswith(REASONING_MODEL_PREFIXES)


def _raw(name):
    value = os.getenv(name)
    if value is None or value.strip() == '':
        return None
    return value.strip()


def _required(name, source):
    value = _raw(name)
    if value is None:
        raise ConfigError(f'{name} is not set. It is expected from {source}.')
    return value


def _optional(name, default):
    value = _raw(name)
    return default if value is None else value


def _number(name, cast, default):
    value = _raw(name)
    if value is None:
        return default
    try:
        return cast(value)
    except ValueError:
        raise ConfigError(f'{name}={value!r} is not a valid {cast.__name__} ({FROM_COMPOSE}).')


def _flag(name, default):
    value = _raw(name)
    if value is None:
        return default
    if value.lower() in ('1', 'true', 'yes', 'on'):
        return True
    if value.lower() in ('0', 'false', 'no', 'off'):
        return False
    raise ConfigError(f'{name}={value!r} must be true or false ({FROM_COMPOSE}).')


def _set(name):
    """A comma- or space-separated allow-list, lower-cased. Empty means 'no list'."""
    value = _raw(name)
    if not value:
        return frozenset()
    return frozenset(part.strip().lower() for part in value.replace(',', ' ').split() if part.strip())


@dataclass(frozen=True)
class Settings:
    # database
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str = field(repr=False)
    # openai
    openai_api_key: str = field(repr=False, default=None)
    openai_base_url: str = 'https://api.openai.com/v1'
    chat_model: str = 'gpt-5.6-luna'
    embedding_model: str = 'text-embedding-3-small'
    judge_model: str = 'gpt-5-nano'
    embedding_dimensions: int = SCHEMA_EMBEDDING_DIMENSIONS
    # agent
    reasoning_effort: str = DEFAULT_REASONING_EFFORT
    temperature: float = 0.0
    max_tokens: int = DEFAULT_MAX_TOKENS_REASONING
    llm_timeout_seconds: float = 90.0
    max_tool_iterations: int = 3
    confidence_threshold: float = 0.55
    # cost, USD per 1K tokens
    cost_per_1k_input: float = 0.0
    cost_per_1k_output: float = 0.0
    cost_per_1k_embedding: float = 0.0
    # modes
    demo_mode: bool = False
    otlp_endpoint: str = None
    # sign-in
    env_type: str = 'DEV'
    entra_tenant_id: str = None
    entra_spa_client_id: str = None
    entra_api_client_id: str = None
    entra_api_scope: str = DEFAULT_ENTRA_SCOPE
    entra_allowed_upns: frozenset = frozenset()
    entra_allowed_groups: frozenset = frozenset()

    @property
    def chat_is_reasoning(self):
        return is_reasoning_model(self.chat_model)

    def snapshot(self):
        """Non-secret configuration, stored on every run."""
        return {
            'openai_base_url': self.openai_base_url,
            'chat_model': self.chat_model,
            'embedding_model': self.embedding_model,
            'judge_model': self.judge_model,
            'embedding_dimensions': self.embedding_dimensions,
            'reasoning_effort': self.reasoning_effort if self.chat_is_reasoning else None,
            'temperature': None if self.chat_is_reasoning else self.temperature,
            'max_tokens': self.max_tokens,
            'llm_timeout_seconds': self.llm_timeout_seconds,
            'max_tool_iterations': self.max_tool_iterations,
            'confidence_threshold': self.confidence_threshold,
            'cost_per_1k_input': self.cost_per_1k_input,
            'cost_per_1k_output': self.cost_per_1k_output,
            'cost_per_1k_embedding': self.cost_per_1k_embedding,
            'demo_mode': self.demo_mode,
            'otlp_enabled': bool(self.otlp_endpoint),
            # Whether the API was checking tokens when this run was made is part of how
            # the run should be read, so it is snapshotted with everything else.
            'env_type': self.env_type,
            'auth': 'entra' if self.env_type == 'PROD' else 'bypassed',
        }

    def snapshot_hash(self):
        canonical = json.dumps(self.snapshot(), sort_keys=True, separators=(',', ':'))
        return hashlib.sha256(canonical.encode()).hexdigest()[:8]


def load_settings():
    demo_mode = _flag('LENS_DEMO_MODE', False)
    # Read first: the token budget means different things to the two families, so its
    # default depends on which one is configured.
    chat_model = _optional('LENS_CHAT_MODEL', 'gpt-5.6-luna')
    default_max_tokens = (DEFAULT_MAX_TOKENS_REASONING if is_reasoning_model(chat_model)
                          else DEFAULT_MAX_TOKENS_STANDARD)
    settings = Settings(
        db_host=_required('LENS_DB_HOST', FROM_COMPOSE),
        db_port=_number('LENS_DB_PORT', int, 5432),
        db_name=_required('LENS_DB_NAME', FROM_VAULT),
        db_user=_required('LENS_DB_USER', FROM_VAULT),
        db_password=_required('LENS_DB_PASSWORD', FROM_VAULT),
        # Demo mode replays recorded model responses, so it can start without a key.
        openai_api_key=_raw('LENS_OPENAI_API_KEY') if demo_mode
        else _required('LENS_OPENAI_API_KEY', FROM_VAULT),
        openai_base_url=_optional('LENS_OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        chat_model=chat_model,
        embedding_model=_optional('LENS_EMBEDDING_MODEL', 'text-embedding-3-small'),
        judge_model=_optional('LENS_JUDGE_MODEL', 'gpt-5-nano'),
        embedding_dimensions=_number('LENS_EMBEDDING_DIMENSIONS', int, SCHEMA_EMBEDDING_DIMENSIONS),
        reasoning_effort=_optional('LENS_REASONING_EFFORT', DEFAULT_REASONING_EFFORT),
        temperature=_number('LENS_LLM_TEMPERATURE', float, 0.0),
        max_tokens=_number('LENS_LLM_MAX_TOKENS', int, default_max_tokens),
        llm_timeout_seconds=_number('LENS_LLM_TIMEOUT_SECONDS', float, 90.0),
        max_tool_iterations=_number('LENS_MAX_TOOL_ITERATIONS', int, 3),
        confidence_threshold=_number('LENS_CONFIDENCE_THRESHOLD', float, 0.55),
        cost_per_1k_input=_number('LENS_COST_PER_1K_INPUT', float, 0.0),
        cost_per_1k_output=_number('LENS_COST_PER_1K_OUTPUT', float, 0.0),
        cost_per_1k_embedding=_number('LENS_COST_PER_1K_EMBEDDING', float, 0.0),
        demo_mode=demo_mode,
        otlp_endpoint=_raw('LENS_OTLP_ENDPOINT'),
        env_type=_optional('LENS_ENV_TYPE', 'DEV').upper(),
        entra_tenant_id=_raw('LENS_ENTRA_TENANT_ID'),
        entra_spa_client_id=_raw('LENS_ENTRA_SPA_CLIENT_ID'),
        # One app registration serves both roles by default: the SPA that signs the user
        # in is also the API the token is minted for. Set it separately only if you split
        # them into two registrations.
        entra_api_client_id=_raw('LENS_ENTRA_API_CLIENT_ID') or _raw('LENS_ENTRA_SPA_CLIENT_ID'),
        entra_api_scope=_optional('LENS_ENTRA_API_SCOPE', DEFAULT_ENTRA_SCOPE),
        entra_allowed_upns=_set('LENS_ENTRA_ALLOWED_UPNS'),
        entra_allowed_groups=_set('LENS_ENTRA_ALLOWED_GROUPS'),
    )
    if settings.embedding_dimensions != SCHEMA_EMBEDDING_DIMENSIONS:
        raise ConfigError(
            f'LENS_EMBEDDING_DIMENSIONS={settings.embedding_dimensions} does not match the schema '
            f'column vector({SCHEMA_EMBEDDING_DIMENSIONS}) in database/sql_init.sql. Change the '
            'column in sql_init.sql AND the _SCHEMA_SQL block in app.py, then re-ingest.'
        )
    if settings.reasoning_effort not in REASONING_EFFORTS:
        raise ConfigError(
            f'LENS_REASONING_EFFORT={settings.reasoning_effort!r} is not accepted by the API. '
            f'Use one of: {", ".join(REASONING_EFFORTS)}. '
            "('minimal' and 'max' were withdrawn; 'low' is the nearest replacement for "
            "'minimal'.) Set it in docker-compose.yml or the root .env.")
    # A reasoning model spends this budget on reasoning before it writes anything, so a
    # cap sized for output alone truncates the answer mid-sentence.
    if settings.chat_is_reasoning and settings.reasoning_effort != 'none' \
            and settings.max_tokens < DEFAULT_MAX_TOKENS_STANDARD:
        raise ConfigError(
            f'LENS_LLM_MAX_TOKENS={settings.max_tokens} is too small for {settings.chat_model} at '
            f'reasoning_effort={settings.reasoning_effort}. On a reasoning model the budget covers '
            f'reasoning AND the answer; use at least {DEFAULT_MAX_TOKENS_STANDARD}, or '
            f'{DEFAULT_MAX_TOKENS_REASONING} for comfort.')
    if not 0 <= settings.confidence_threshold <= 1:
        raise ConfigError('LENS_CONFIDENCE_THRESHOLD must be between 0 and 1.')
    if not 1 <= settings.max_tool_iterations <= 5:
        raise ConfigError('LENS_MAX_TOOL_ITERATIONS must be between 1 and 5.')
    if settings.env_type not in ENV_TYPES:
        raise ConfigError(
            f'LENS_ENV_TYPE={settings.env_type!r} is not one of {", ".join(ENV_TYPES)}. '
            'PROD requires an Entra access token on every API call; DEV bypasses sign-in. '
            f'It comes from {FROM_VAULT} as LENS-ENV-TYPE.')
    if settings.env_type == 'PROD':
        # Refusing to start is the only safe answer: a PROD container that came up with
        # half the Entra configuration would serve the whole API unauthenticated.
        missing = [name for name, value in (
            ('LENS_ENTRA_TENANT_ID', settings.entra_tenant_id),
            ('LENS_ENTRA_SPA_CLIENT_ID', settings.entra_spa_client_id),
            ('LENS_ENTRA_API_CLIENT_ID', settings.entra_api_client_id),
        ) if not value]
        if missing:
            raise ConfigError(
                f'LENS_ENV_TYPE=PROD, so sign-in is enforced, but {", ".join(missing)} '
                f'{"is" if len(missing) == 1 else "are"} not set. They come from {FROM_VAULT}. '
                'See docs/ENTRA_SETUP.md, or set LENS-ENV-TYPE to DEV to run without sign-in.')
    return settings


@lru_cache(maxsize=1)
def get_settings():
    return load_settings()
