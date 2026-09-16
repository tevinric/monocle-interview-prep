"""
Sign-in — Microsoft Entra ID, validated on the API rather than trusted from the browser.

The browser acquires an access token from Entra for this application's own API scope and
sends it as `Authorization: Bearer <token>`. Nothing about that token is taken on faith:
every request re-verifies it here, against the tenant's published signing keys.

  signature   RS256, against the JWKS for the configured tenant. The keys are fetched
              from Microsoft and cached; a token signed by anything else is rejected.
  issuer      must be the configured tenant's issuer. A token from another directory is
              a valid token — just not one of ours.
  audience    must be this API's application ID URI. A token minted for Graph, or for a
              different API in the same tenant, is rejected here: audience is what stops
              a token being replayed against a service it was not issued for.
  scope       the delegated scope the SPA asked for must be present in `scp`. An app-only
              token (`roles`, no user) is rejected — Lens has no daemon callers.
  tenant      `tid` must match. Belt and braces with the issuer check, and it is the claim
              a reader looks for.
  who         optionally, the account must appear in an allow-list of UPNs or groups.
              The first line of defence is still 'User assignment required' on the
              enterprise application; this is the second, and it lives in configuration
              so it can be changed without touching Entra.

`LENS_ENV_TYPE` decides whether any of this runs:

  PROD   every /api route except the two public ones needs a valid token.
  DEV    authentication is bypassed entirely and the frontend never loads MSAL. This is
         what makes the stack runnable on a laptop with no Entra tenant.

The bypass is deliberately loud: it is reported by /api/health and /api/auth/config, it
is written into every run's configuration snapshot, and the backend logs it at startup.
A demo that is not checking tokens should never be able to look like one that is.
"""
import logging
from functools import wraps

import jwt
from flask import g, jsonify, request
from jwt import PyJWKClient

from lens.config import get_settings

logger = logging.getLogger(__name__)

# Paths that answer without a token. Kept to the two that cannot need one: the container
# healthcheck, and the call the browser makes to find out how to sign in.
PUBLIC_PATHS = ('/api/health', '/api/auth/config')

# Microsoft rotates signing keys; PyJWKClient re-fetches when it sees an unknown `kid`
# and caches what it has in between, so this is one request per key rotation, not one
# per API call.
_JWK_CACHE_SECONDS = 600

_jwk_client = None


class AuthError(Exception):
    """A request that will not be served. `status` is what the browser should see."""

    def __init__(self, message, status=401, detail=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.detail = detail


def auth_enabled(settings=None):
    return (settings or get_settings()).env_type == 'PROD'


def authority(settings):
    return f'https://login.microsoftonline.com/{settings.entra_tenant_id}'


def jwks_uri(settings):
    return f'{authority(settings)}/discovery/v2.0/keys'


def issuers(settings):
    """
    Both issuer forms for the configured tenant.

    v2 tokens (what this app should be issuing — see the setup guide, step 6) carry the
    `/v2.0` issuer. v1 tokens carry the sts.windows.net form. Accepting both means a
    tenant left on the default token version still works, while a token from any OTHER
    tenant still fails.
    """
    tid = settings.entra_tenant_id
    return (f'https://login.microsoftonline.com/{tid}/v2.0', f'https://sts.windows.net/{tid}/')


def audiences(settings):
    """
    What this API is called in a token.

    Entra puts the Application ID URI in `aud` for v2 tokens (`api://<client-id>`) and the
    bare client id for v1. Both name this API and nothing else.
    """
    api_id = settings.entra_api_client_id
    return (f'api://{api_id}', api_id)


def scopes(settings):
    """The scope the SPA requests, as MSAL must ask for it."""
    return [f'api://{settings.entra_api_client_id}/{settings.entra_api_scope}']


def get_jwk_client(settings):
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(jwks_uri(settings), cache_keys=True, lifespan=_JWK_CACHE_SECONDS)
    return _jwk_client


def bearer_token(headers):
    header = headers.get('Authorization', '')
    if not header:
        raise AuthError('This request carried no access token. Sign in and try again.')
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != 'bearer' or not parts[1].strip():
        raise AuthError('The Authorization header is not a bearer token.')
    return parts[1].strip()


def _claim_list(claims, name):
    value = claims.get(name)
    if isinstance(value, str):
        return value.split()
    return list(value or [])


def validate_token(token, settings=None):
    """
    Verify one access token and return the identity it asserts.

    Raises AuthError with a message fit to show a person. The detail that is only useful
    to whoever is configuring the tenant goes to the log, not to the browser.
    """
    settings = settings or get_settings()
    try:
        signing_key = get_jwk_client(settings).get_signing_key_from_jwt(token)
    except Exception as e:
        # A network failure reaching Microsoft and a token signed by a key that is not in
        # the tenant's key set are both fatal to this request, but only one of them is the
        # caller's fault; the log is where they are told apart.
        logger.warning(f'Could not resolve a signing key for a presented token: {e}')
        raise AuthError('This access token could not be verified against the tenant.')

    try:
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=['RS256'],
            audience=list(audiences(settings)),
            leeway=60,  # for clock skew between the container and Entra, nothing more
            options={'require': ['exp', 'iat', 'iss', 'aud', 'sub'],
                     'verify_signature': True, 'verify_exp': True, 'verify_aud': True},
        )
    except jwt.ExpiredSignatureError:
        raise AuthError('This session has expired. Sign in again.')
    except jwt.InvalidAudienceError:
        raise AuthError('This token was issued for a different application.', detail='aud')
    except jwt.InvalidTokenError as e:
        raise AuthError('This access token is not valid.', detail=str(e))

    # The issuer is checked here rather than passed to jwt.decode: two forms are
    # acceptable (see `issuers`), and PyJWT only began accepting a list of issuers in
    # 2.10. Doing it by hand keeps the rule the same whatever version is installed.
    if claims.get('iss') not in issuers(settings):
        raise AuthError('This token was issued by a different directory.',
                        detail=f'iss={claims.get("iss")}')

    if claims.get('tid') != settings.entra_tenant_id:
        raise AuthError('This token belongs to another directory.', detail='tid')

    # A delegated token carries `scp` and a user. An app-only token carries `roles` and no
    # user, and Lens has no machine callers — everything it does is on behalf of a person
    # whose question is about to be written into the audit trail.
    granted = _claim_list(claims, 'scp')
    if settings.entra_api_scope not in granted:
        raise AuthError(
            f'This token does not carry the {settings.entra_api_scope} scope.',
            status=403, detail=f'scp={granted}')

    identity = {
        'name': claims.get('name'),
        'username': claims.get('preferred_username') or claims.get('upn') or claims.get('unique_name'),
        'oid': claims.get('oid'),
        'tid': claims.get('tid'),
        'scopes': granted,
        'groups': _claim_list(claims, 'groups'),
        'expires_at': claims.get('exp'),
    }

    allowed_upns = settings.entra_allowed_upns
    if allowed_upns:
        username = (identity['username'] or '').lower()
        if username not in allowed_upns:
            raise AuthError('This account is not on the Lens access list.', status=403,
                            detail=f'upn={username}')

    allowed_groups = settings.entra_allowed_groups
    if allowed_groups:
        if not set(identity['groups']) & allowed_groups:
            raise AuthError(
                'This account is not in a group with access to Lens.', status=403,
                # An empty groups claim here is nearly always a configuration miss rather
                # than a genuine refusal — the optional claim was not added to the app.
                detail=f'groups={identity["groups"] or "(no groups claim in the token)"}')

    return identity


def is_public(path):
    return any(path == p or path.startswith(f'{p}/') for p in PUBLIC_PATHS)


def enforce():
    """
    Flask `before_request` hook: one gate in front of the whole API.

    Deliberately not a decorator on each route. A decorator is something a new route can
    forget; this cannot be forgotten, and the list of what is public is one short tuple
    that a reviewer can read in a second.
    """
    settings = get_settings()
    if request.method == 'OPTIONS' or not request.path.startswith('/api/'):
        return None
    if is_public(request.path):
        return None
    if not auth_enabled(settings):
        g.identity = {'name': 'Development bypass', 'username': None, 'oid': None,
                      'tid': None, 'scopes': [], 'groups': [], 'bypass': True}
        return None
    try:
        g.identity = validate_token(bearer_token(request.headers), settings)
    except AuthError as e:
        if e.detail:
            logger.warning(f'Rejected {request.method} {request.path}: {e.message} ({e.detail})')
        return jsonify({'error': e.message, 'code': 'unauthenticated' if e.status == 401
                        else 'forbidden'}), e.status
    return None


def public_config(settings=None):
    """
    What the browser needs to sign in — and nothing else.

    Every value here is public by nature: a client id, a tenant id and a scope name are
    all visible in the address bar during a sign-in. No secret is involved in this flow
    at all, which is the point of the authorization-code + PKCE grant the SPA uses.
    """
    settings = settings or get_settings()
    if not auth_enabled(settings):
        return {'mode': 'open', 'env_type': settings.env_type,
                'reason': 'LENS_ENV_TYPE is DEV, so sign-in is bypassed.'}
    return {
        'mode': 'entra',
        'env_type': settings.env_type,
        'client_id': settings.entra_spa_client_id,
        'tenant_id': settings.entra_tenant_id,
        'authority': authority(settings),
        'scopes': scopes(settings),
    }


def require_auth(view):
    """For a route that must have an identity even if the gate above is ever relaxed."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if auth_enabled() and not getattr(g, 'identity', None):
            return jsonify({'error': 'Sign in to use this endpoint.',
                            'code': 'unauthenticated'}), 401
        return view(*args, **kwargs)
    return wrapped
