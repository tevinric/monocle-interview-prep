"""
make check-auth — prove the sign-in configuration before you rely on it.

Two things are worth checking before a demo, and neither of them is "did the button
work":

  1. Is this container's Entra configuration real? The tenant's own OpenID metadata is
     fetched and its issuer and signing keys are printed. A wrong tenant id fails here in
     a second rather than as an opaque redirect error in a browser.
  2. Does the validator actually reject what it should? A local RSA key signs a set of
     deliberately wrong tokens — another directory's issuer, another application's
     audience, an expired one, one with no scope, one signed by a key the tenant never
     published — and every one of them has to be refused. This is the check worth doing
     out loud: "here is the token the browser sends, and here is it being rejected when
     any one claim is wrong."

Nothing is written to the database, no spans are created, and no real token is needed.
"""
import json
import sys
import time

from lens.auth import AuthError, audiences, authority, issuers, jwks_uri, scopes, validate_token
from lens.config import get_settings


def describe(settings):
    print('Lens sign-in check')
    print(f'  LENS_ENV_TYPE : {settings.env_type}')
    if settings.env_type != 'PROD':
        print('\n  Sign-in is BYPASSED. Every /api route answers without a token, and the')
        print('  browser never loads MSAL. Set LENS-ENV-TYPE to PROD in the Key Vault to')
        print('  enforce Entra sign-in, then restart the backend.')
        return False
    print(f'  tenant        : {settings.entra_tenant_id}')
    print(f'  SPA client    : {settings.entra_spa_client_id}')
    print(f'  API client    : {settings.entra_api_client_id}')
    print(f'  authority     : {authority(settings)}')
    print(f'  accepted iss  : {", ".join(issuers(settings))}')
    print(f'  accepted aud  : {", ".join(audiences(settings))}')
    print(f'  required scope: {settings.entra_api_scope}')
    print(f'  MSAL asks for : {scopes(settings)[0]}')
    if settings.entra_allowed_upns:
        print(f'  UPN allow-list: {", ".join(sorted(settings.entra_allowed_upns))}')
    if settings.entra_allowed_groups:
        print(f'  group list    : {", ".join(sorted(settings.entra_allowed_groups))}')
    return True


def check_tenant(settings):
    """Ask Microsoft about the configured tenant. A wrong id has no metadata."""
    import requests
    url = f'{authority(settings)}/v2.0/.well-known/openid-configuration'
    print(f'\ntenant metadata: {url}')
    started = time.perf_counter()
    response = requests.get(url, timeout=15)
    elapsed = int((time.perf_counter() - started) * 1000)
    if response.status_code != 200:
        raise RuntimeError(f'{response.status_code} — check LENS-ENTRA-TENANT-ID. {response.text[:200]}')
    metadata = response.json()
    print(f'  responded     : {elapsed} ms')
    print(f'  issuer        : {metadata["issuer"]}')
    if metadata['issuer'] not in issuers(settings):
        raise RuntimeError(f'the tenant issues {metadata["issuer"]}, which this backend would reject')
    keys = requests.get(jwks_uri(settings), timeout=15).json().get('keys', [])
    print(f'  signing keys  : {len(keys)} published ({", ".join(k["kid"][:8] for k in keys[:4])}…)')
    return True


def check_rejections(settings):
    """Sign deliberately wrong tokens locally and require every one to be refused."""
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
    from lens import auth as auth_module

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class Signing:
        def __init__(self, k):
            self.key = k.public_key()

    class Client:
        def get_signing_key_from_jwt(self, token):
            return Signing(key)

    # For the duration of this check the tenant's key set is our local key, so a token we
    # signed stands in for one Entra signed. Every OTHER claim is still checked for real.
    original = auth_module.get_jwk_client
    auth_module.get_jwk_client = lambda s: Client()

    tenant = settings.entra_tenant_id
    api = settings.entra_api_client_id

    def make(signer=key, **overrides):
        now = int(time.time())
        claims = {'iss': f'https://login.microsoftonline.com/{tenant}/v2.0',
                  'aud': f'api://{api}', 'tid': tenant, 'sub': 'selftest', 'oid': 'selftest',
                  'iat': now - 30, 'nbf': now - 30, 'exp': now + 600,
                  'scp': settings.entra_api_scope, 'name': 'Self test',
                  'preferred_username': 'selftest@example.invalid'}
        claims.update({k: v for k, v in overrides.items() if v is not None})
        for k, v in overrides.items():
            if v is None:
                claims.pop(k, None)
        return jwt.encode(claims, signer, algorithm='RS256')

    cases = [
        ('a well-formed token for this API', make(), True),
        ('signed by a key the tenant never published', make(stranger), False),
        ('issued for another application', make(aud='api://00000003-0000-0000-c000-000000000000'), False),
        ('issued by another directory', make(iss='https://login.microsoftonline.com/'
                                             '99999999-9999-9999-9999-999999999999/v2.0'), False),
        ('carrying another directory\'s tid', make(tid='99999999-9999-9999-9999-999999999999'), False),
        ('expired an hour ago', make(exp=int(time.time()) - 3600), False),
        ('without the API scope', make(scp='User.Read'), False),
        ('app-only, with no delegated scope', make(scp=None), False),
    ]

    print('\nvalidator:')
    failures = []
    try:
        for label, token, should_pass in cases:
            try:
                identity = validate_token(token, settings)
                accepted, why = True, identity.get('username')
            except AuthError as e:
                accepted, why = False, f'{e.status} {e.message}'
            ok = accepted == should_pass
            verdict = 'accepted' if accepted else 'rejected'
            print(f'  {"ok  " if ok else "FAIL"} {label:<48} {verdict}'
                  + (f' — {why}' if not accepted else ''))
            if not ok:
                failures.append(label)
    finally:
        auth_module.get_jwk_client = original
    if failures:
        raise RuntimeError(f'{len(failures)} validator case(s) behaved wrongly: {failures}')
    return True


def main():
    settings = get_settings()
    if not describe(settings):
        return
    failures = []
    for label, check in (('tenant metadata', check_tenant), ('validator', check_rejections)):
        try:
            check(settings)
        except Exception as e:
            failures.append(f'{label}: {e.__class__.__name__}: {e}')
            print(f'  FAILED        : {e.__class__.__name__}: {e}')

    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  - {f}')
        print('\nSee docs/ENTRA_SETUP.md. The values come from the Key Vault as '
              'LENS-ENTRA-* and LENS-ENV-TYPE.')
        raise SystemExit(1)

    print('\nSign-in is configured and the validator refuses everything it should.')
    print(f'The browser will be told: {json.dumps(scopes(settings))}')


if __name__ == '__main__':
    main()
