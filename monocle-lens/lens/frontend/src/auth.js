/**
 * Sign-in — Microsoft Entra ID, from the browser's side.
 *
 * The flow is authorization code with PKCE, which is the only one a single-page app
 * should use: no client secret exists anywhere in this code or in the built bundle,
 * and the code that comes back from Entra is worthless without the verifier this tab
 * generated and kept.
 *
 * What the browser holds is an ACCESS TOKEN for this application's own API scope, and
 * it is not a credential in any useful sense — the backend re-verifies its signature,
 * issuer, audience, tenant and scope on every single request (see lens/auth.py). The
 * browser cannot grant itself access by holding a token; it can only present one that
 * Entra signed.
 *
 * Configuration is fetched from the API rather than baked into the build, so the tenant
 * and client id live in the Key Vault with everything else and a new environment does
 * not mean a new frontend image.
 *
 * When the API reports mode 'open' (LENS_ENV_TYPE=DEV) none of this runs: MSAL is never
 * constructed, no token is requested, and no Authorization header is sent.
 */
// MSAL is loaded on demand rather than imported at the top: it is a third of the bundle,
// and a DEV environment with sign-in bypassed should never download it at all.
let msalModule = null

async function msalLibrary() {
  if (!msalModule) msalModule = await import('@azure/msal-browser')
  return msalModule
}

const state = {
  mode: null, // 'open' | 'entra'
  config: null,
  msal: null,
  account: null,
}

const listeners = new Set()

function announce() {
  listeners.forEach((fn) => fn(snapshot()))
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function snapshot() {
  return { mode: state.mode, account: state.account, config: state.config }
}

export const authMode = () => state.mode
export const currentAccount = () => state.account
export const isSignedIn = () => state.mode === 'open' || !!state.account

/** The API is the authority on how to sign in; ask it before doing anything else. */
async function fetchAuthConfig(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/config`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`The API would not say how to sign in (${response.status}).`)
  return response.json()
}

/**
 * Start up. Resolves once we know whether a sign-in is needed and whether we have one.
 *
 * `handleRedirectPromise` has to run before anything else looks at the cache: on the way
 * back from Entra the tab is holding an authorization code in its URL, and that is the
 * call that exchanges it and cleans the address bar.
 */
export async function initAuth(baseUrl = '') {
  const config = await fetchAuthConfig(baseUrl)
  state.config = config
  state.mode = config.mode

  if (config.mode !== 'entra') {
    announce()
    return snapshot()
  }

  const { createStandardPublicClientApplication } = await msalLibrary()
  state.msal = await createStandardPublicClientApplication({
    auth: {
      clientId: config.client_id,
      authority: config.authority,
      // Registered in Entra under Authentication → Single-page application. The origin
      // alone keeps the registration to one URI per environment; MSAL returns the tab to
      // the page it left from afterwards.
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
      navigateToLoginRequestUrl: true,
    },
    cache: {
      // Per tab, and gone when the tab closes. A shared workstation should not leave a
      // signed-in Lens behind; the Entra session cookie still makes the next sign-in a
      // click rather than a password.
      cacheLocation: 'sessionStorage',
      storeAuthStateInCookie: false,
    },
  })

  const result = await state.msal.handleRedirectPromise()
  if (result?.account) {
    state.msal.setActiveAccount(result.account)
  } else {
    const known = state.msal.getAllAccounts()
    if (known.length) state.msal.setActiveAccount(known[0])
  }
  state.account = state.msal.getActiveAccount() || null
  announce()
  return snapshot()
}

export function signIn() {
  if (state.mode !== 'entra') return Promise.resolve()
  if (!state.msal) {
    // initAuth failed before MSAL was built — almost always the API being unreachable.
    // Saying so beats a button that does nothing.
    throw new Error('Sign-in is not ready: Lens could not reach its API. Reload the page.')
  }
  // Redirect rather than popup: a popup is what a blocker eats, and this is a gate in
  // front of the whole application rather than a step inside it.
  // No `prompt` is sent: where a Microsoft session already exists the person goes
  // straight through, and where it does not they are asked. The account they arrived as
  // is named in the rail, with a way out beside it, so nothing is hidden by the shortcut.
  return state.msal.loginRedirect({ scopes: state.config.scopes })
}

export function signOut() {
  if (state.mode !== 'entra' || !state.account) return Promise.resolve()
  return state.msal.logoutRedirect({ account: state.account })
}

/**
 * A token for the API call about to be made.
 *
 * Silent first — MSAL serves it from its own cache, or renews it behind the scenes. Only
 * when Entra says it genuinely needs the person (consent, MFA, an expired session) does
 * this hand the tab over, and that is a redirect rather than a silent failure so the
 * reason is on screen rather than in a console.
 */
export async function getAccessToken() {
  if (state.mode !== 'entra' || !state.account) return null
  try {
    const result = await state.msal.acquireTokenSilent({
      scopes: state.config.scopes,
      account: state.account,
    })
    return result.accessToken
  } catch (error) {
    const { InteractionRequiredAuthError } = await msalLibrary()
    if (error instanceof InteractionRequiredAuthError) {
      await state.msal.acquireTokenRedirect({ scopes: state.config.scopes, account: state.account })
      return null
    }
    throw error
  }
}

/** The signed-in person, in the form the interface shows them. */
export function accountLabel(account = state.account) {
  if (!account) return null
  return account.name || account.username || account.localAccountId
}


/**
 * The API refused a token we believed in.
 *
 * A silent renewal covers an ordinary expiry, so reaching here means the session is
 * genuinely over — revoked, the account removed from the application, or a clock far
 * enough out that Entra and the API disagree. Send the person back through sign-in
 * rather than leaving an interface that fails on every click. Once only: a redirect is
 * in flight after the first.
 */
let reauthenticating = false

export function reauthenticate() {
  if (state.mode !== 'entra' || reauthenticating || !state.msal) return
  reauthenticating = true
  state.msal.loginRedirect({ scopes: state.config.scopes }).catch(() => {
    reauthenticating = false
  })
}


/**
 * The person's first name, for the one place the interface addresses them directly.
 *
 * `given_name` is the claim to trust: it is the name as the directory holds it, already
 * split from the surname. Entra omits it for some account types, so this falls back —
 * through the display name (handling the "Surname, Forename" form some tenants issue),
 * then the local part of the username — rather than greeting nobody. Null only when
 * there is no account at all, which is every DEV session.
 */
export function accountFirstName(account = state.account) {
  if (!account) return null

  const claims = account.idTokenClaims || {}
  const given = claims.given_name || claims.givenname
  if (given && String(given).trim()) return String(given).trim().split(/\s+/)[0]

  const display = (account.name || '').trim()
  if (display) {
    // "Richard, Tevin" — the forename is what follows the comma.
    if (display.includes(',')) {
      const forename = display.split(',')[1]?.trim()
      if (forename) return forename.split(/\s+/)[0]
    }
    return display.split(/\s+/)[0]
  }

  const local = (account.username || '').split('@')[0]
  if (local) {
    const first = local.split(/[._\-+]/)[0]
    if (first) return first.charAt(0).toUpperCase() + first.slice(1)
  }
  return null
}

/**
 * A stable key for this account, so a preference recorded against one person — whether
 * the welcome tour has been turned off — does not follow the next person to sign in on
 * the same machine. `homeAccountId` is unique per account per tenant and survives a
 * sign-out; DEV has no account at all and shares one key.
 */
export function accountKey(account = state.account) {
  if (!account) return 'local'
  return account.homeAccountId || account.localAccountId || account.username || 'local'
}
