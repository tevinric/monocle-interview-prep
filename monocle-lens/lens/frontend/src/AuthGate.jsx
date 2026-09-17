import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import Login from './pages/Login'
import LensMark from './components/LensMark'
import { apiBaseUrl } from './api'
import { accountFirstName, accountKey, accountLabel, initAuth, signIn, signOut, subscribe } from './auth'

const AuthContext = createContext({
  mode: 'open',
  account: null,
  name: null,
  firstName: null,
  accountKey: 'local',
  signOut: () => {},
})

export const useAuth = () => useContext(AuthContext)

/** While the API is being asked how to sign in. A moment, usually — but a blank
 *  white page for that moment would read as a broken application. */
function Booting() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-navy-deep" role="status">
      <span className="sr-only">Starting Lens…</span>
      <LensMark className="h-12 w-12 opacity-90" animated aria-hidden="true" />
    </div>
  )
}

/**
 * Everything behind sign-in.
 *
 * In DEV the API reports mode 'open' and this is a pass-through: MSAL is never loaded and
 * no token is ever requested. In PROD it renders the sign-in page until there is an
 * account, and the application only mounts once there is one — no page of the interface
 * is ever built from data the API would have refused to send.
 */
export default function AuthGate({ children }) {
  const [state, setState] = useState({ status: 'booting', mode: null, account: null })
  const [error, setError] = useState(null)

  useEffect(() => subscribe((snap) =>
    setState((current) => ({ ...current, mode: snap.mode, account: snap.account }))), [])

  useEffect(() => {
    let cancelled = false
    initAuth(apiBaseUrl)
      .then((snap) => {
        if (!cancelled) setState({ status: 'ready', mode: snap.mode, account: snap.account })
      })
      .catch((e) => {
        if (cancelled) return
        // Two very different failures land here — the API being down, and a sign-in that
        // Entra refused — so the message says which rather than "something went wrong".
        setState({ status: 'ready', mode: 'entra', account: null })
        setError(
          /sign in/i.test(String(e?.message))
            ? String(e.message)
            : `Lens could not reach its API to start sign-in. ${e?.message || ''}`.trim(),
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  const doSignIn = useCallback(async () => {
    setError(null)
    try {
      await signIn()
    } catch (e) {
      setError(`Sign-in did not start: ${e?.errorMessage || e?.message || e}`)
    }
  }, [])

  if (state.status === 'booting') return <Booting />

  if (state.mode === 'entra' && !state.account) {
    return <Login mode={state.mode} onSignIn={doSignIn} error={error} />
  }

  return (
    <AuthContext.Provider
      value={{
        mode: state.mode,
        account: state.account,
        name: accountLabel(state.account),
        // The forename greets the person once, in the welcome dialog; the key scopes
        // their tour preference to them rather than to the browser.
        firstName: accountFirstName(state.account),
        accountKey: accountKey(state.account),
        username: state.account?.username || null,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
