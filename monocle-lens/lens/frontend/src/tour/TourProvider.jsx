import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../AuthGate'
import { getRuns } from '../api'
import TourOverlay from './TourOverlay'
import WelcomeDialog from './WelcomeDialog'
import { buildSteps } from './steps'
import { isSuppressed, markGreeted, setSuppressed, wasGreeted } from './storage'

const TourContext = createContext({
  running: false,
  start: () => {},
  stop: () => {},
})

export const useTour = () => useContext(TourContext)

/** The event TraceViews listens for, so a tour stop can change which reading is drawn. */
export const TRACE_VIEW_EVENT = 'lens:tour-trace-view'

/**
 * The guided tour: its state, and the two things that sit on top of the application.
 *
 * Mounted inside the router and inside AuthGate, so it knows who signed in and can drive
 * navigation. It owns three decisions and nothing else:
 *
 *   whether to offer the tour at all  — once per sign-in, unless turned off for good
 *   which stop is current             — and therefore which route the application is on
 *   when to stop                      — Escape, Skip, Finish, or signing out
 *
 * Everything visual is in TourOverlay; everything said is in steps.js. Nothing here
 * touches the pages themselves: they cooperate only by carrying `data-tour` attributes,
 * so a page that changes shape degrades to a centred card rather than breaking.
 */
export default function TourProvider({ children }) {
  const { firstName, accountKey, mode } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const [phase, setPhase] = useState('idle') // idle | welcome | running
  const [index, setIndex] = useState(0)
  const [steps, setSteps] = useState([])
  const [preparing, setPreparing] = useState(false)
  const [suppress, setSuppress] = useState(() => isSuppressed(accountKey))

  // Where the reader was when the tour started, so leaving it puts them back rather than
  // abandoning them on the last screen the tour happened to reach.
  const origin = useRef('/')

  useEffect(() => {
    setSuppress(isSuppressed(accountKey))
  }, [accountKey])

  // The greeting, once per sign-in. In DEV (mode 'open') there is no account and no
  // name, and the dialog greets generically rather than not appearing — the tour is as
  // useful to someone running this locally as to someone arriving through Entra.
  useEffect(() => {
    if (!mode) return
    if (isSuppressed(accountKey) || wasGreeted(accountKey)) return
    markGreeted(accountKey)
    setPhase('welcome')
  }, [mode, accountKey])

  /**
   * Begin.
   *
   * The trace chapter needs a real run to open, so the most recent one is looked up
   * first. A stack with no history yet — or an API that does not answer in time — simply
   * gets the tour without that chapter; it is never a reason to refuse to start.
   */
  const start = useCallback(async () => {
    setPreparing(true)
    let runId = null
    try {
      const res = await Promise.race([
        getRuns({}),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ])
      runId = res?.data?.runs?.[0]?.id || null
    } catch {
      runId = null
    }
    origin.current = window.location.pathname || '/'
    setSteps(buildSteps({ runId }))
    setIndex(0)
    setPreparing(false)
    setPhase('running')
  }, [])

  const stop = useCallback(
    ({ returnHome = true } = {}) => {
      setPhase('idle')
      setIndex(0)
      setSteps([])
      if (returnHome && origin.current && window.location.pathname !== origin.current) {
        navigate(origin.current)
      }
    },
    [navigate],
  )

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= steps.length) {
        // Finishing is not cancelling: the reader stays where the tour left them, which
        // is the Help page, rather than being thrown back to the chat.
        setPhase('idle')
        setSteps([])
        return 0
      }
      return i + 1
    })
  }, [steps.length])

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  const step = phase === 'running' ? steps[index] : null

  // The application follows the tour. Compared against the live pathname so a reader who
  // clicks a link mid-tour is brought back to the stop they are reading.
  useEffect(() => {
    if (!step) return
    if (step.route && step.route !== pathname) navigate(step.route)
  }, [step, pathname, navigate])

  // A stop that wants a particular reading of the trace asks for it; TraceViews answers
  // if it happens to be mounted, and nothing happens if it is not.
  useEffect(() => {
    if (!step?.traceView) return
    window.dispatchEvent(new CustomEvent(TRACE_VIEW_EVENT, { detail: step.traceView }))
  }, [step])

  const remember = useCallback(
    (value) => {
      setSuppress(value)
      setSuppressed(accountKey, value)
    },
    [accountKey],
  )

  const value = useMemo(
    () => ({
      phase,
      running: phase === 'running',
      preparing,
      start,
      stop,
      suppressed: suppress,
      setSuppressed: remember,
    }),
    [phase, preparing, start, stop, suppress, remember],
  )

  return (
    <TourContext.Provider value={value}>
      {children}

      {phase === 'welcome' && (
        <WelcomeDialog
          firstName={firstName}
          preparing={preparing}
          suppressed={suppress}
          onSuppress={remember}
          onStart={() => start()}
          onDismiss={() => setPhase('idle')}
        />
      )}

      {step && (
        <TourOverlay
          step={step}
          index={index}
          total={steps.length}
          onNext={next}
          onBack={back}
          onClose={() => stop()}
          suppressed={suppress}
          onSuppress={remember}
        />
      )}
    </TourContext.Provider>
  )
}
