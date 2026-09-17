/**
 * Where the tour's two preferences live.
 *
 * "Do not show this again" is a decision about the person, not the browser, so it is
 * recorded against their account key and survives the tab closing — localStorage. It is
 * also the only thing here that persists: nothing else about the tour is stored.
 *
 * "Already offered in this session" is a decision about this sign-in, so it is
 * sessionStorage, which MSAL also uses for its account cache. Closing the tab and
 * signing in again is a new session and the welcome comes back; a page reload is not.
 *
 * Both are wrapped: storage throws in some privacy modes, and a greeting is a
 * convenience rather than something worth breaking the application for. When it is
 * unavailable the welcome simply appears, which is the safe way to fail.
 */
const SUPPRESS_KEY = 'lens.tour.suppressed'
const GREETED_KEY = 'lens.tour.greeted'

function read(storage, key) {
  try {
    return window[storage].getItem(key)
  } catch {
    return null
  }
}

function write(storage, key, value) {
  try {
    window[storage].setItem(key, value)
  } catch {
    /* a private window should still get a working screen */
  }
}

/** The set of account keys that have asked not to be offered the tour again. */
function suppressedAccounts() {
  try {
    const raw = read('localStorage', SUPPRESS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function isSuppressed(accountKey) {
  return suppressedAccounts().includes(accountKey)
}

export function setSuppressed(accountKey, suppressed) {
  const current = suppressedAccounts().filter((key) => key !== accountKey)
  if (suppressed) current.push(accountKey)
  write('localStorage', SUPPRESS_KEY, JSON.stringify(current))
}

export function wasGreeted(accountKey) {
  return read('sessionStorage', GREETED_KEY) === accountKey
}

export function markGreeted(accountKey) {
  write('sessionStorage', GREETED_KEY, accountKey)
}
