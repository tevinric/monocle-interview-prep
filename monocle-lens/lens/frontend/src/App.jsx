import { useEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import Ask from './pages/Ask'
import Audit from './pages/Audit'
import AuditDetail from './pages/AuditDetail'
import Corpus from './pages/Corpus'
import Evals from './pages/Evals'
import Help from './pages/Help'
import Brand from './components/Brand'
import ErrorBoundary from './components/ErrorBoundary'
import { useAuth } from './AuthGate'
import { useTour } from './tour/TourProvider'
import { getMeta } from './api'

const NAV = [
  { to: '/', label: 'Ask', end: true },
  { to: '/audit', label: 'Audit' },
  { to: '/corpus', label: 'Corpus' },
  { to: '/evals', label: 'Evaluation' },
  { to: '/help', label: 'Help' },
]

/** Model, prompt bundle and config hash — the provenance that makes any answer
 *  on screen reproducible. Present on every page, deliberately. */
function RunContext({ meta, className = '' }) {
  if (!meta) return null
  const rows = [
    ['Model', meta.config?.chat_model, false],
    ['Prompts', meta.prompt_bundle, true],
    ['Config', meta.config_hash, true],
    meta.demo_mode ? ['Mode', 'recorded responses', false] : null,
  ]
    // Drop the absent row first — destructuring null in the predicate below
    // would throw, and this block sits in the chrome, outside the boundary
    // that protects the routes.
    .filter(Boolean)
    .filter(([, value]) => value != null && value !== '')
  if (!rows.length) return null

  return (
    <dl className={className}>
      {rows.map(([label, value, mono]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 py-[3px]">
          <dt className="shrink-0 text-slate2-onDark">{label}</dt>
          <dd
            className={`truncate text-right ${mono ? 'font-mono' : ''} ${
              label === 'Mode' ? 'text-teal' : 'text-paper'
            }`}
            title={String(value ?? '')}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The signed-in account, and the way out. Absent entirely when the API is running
 *  with sign-in bypassed, rather than showing a person who is not there. */
function Account({ className = '' }) {
  const { mode, name, username, signOut } = useAuth()
  if (mode !== 'entra' || !name) return null
  return (
    <div className={className}>
      <p className="eyebrow-dark">Signed in</p>
      <p className="mt-1.5 truncate text-body font-medium text-paper" title={username || name}>
        {name}
      </p>
      {username && username !== name && (
        <p className="truncate text-meta text-slate2-onDark" title={username}>
          {username}
        </p>
      )}
      <button
        type="button"
        onClick={() => signOut()}
        className="mt-2 inline-flex items-center rounded px-2 py-1 text-meta font-medium text-slate2-onDark transition-colors duration-200 ease-smooth hover:bg-paper/10 hover:text-paper"
      >
        Sign out
      </button>
    </div>
  )
}

/**
 * The way back into the guided tour.
 *
 * It sits with the navigation rather than in a help menu because that is where someone
 * looks for it a week later, and it is marked with the aperture rather than a label so it
 * reads as a mode the application can enter rather than a sixth destination.
 */
function TourLaunch({ orientation }) {
  const { start, preparing, running } = useTour()
  const vertical = orientation === 'vertical'
  return (
    <button
      type="button"
      data-tour="tour-launch"
      onClick={() => start()}
      disabled={preparing || running}
      className={[
        'group relative flex items-center gap-2.5 text-left transition-colors duration-300 ease-smooth disabled:cursor-not-allowed disabled:opacity-60',
        vertical ? 'w-full py-2.5 pl-[26px] pr-4 text-body' : 'shrink-0 px-1 py-3.5 text-body',
        'font-normal text-slate2-onDark hover:text-paper',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'absolute bg-paper/25 transition-transform duration-200 ease-smooth',
          vertical
            ? 'inset-y-1 left-0 w-[2px] origin-center scale-y-0 group-hover:scale-y-100'
            : 'inset-x-0 bottom-0 h-[2px] origin-left scale-x-0 group-hover:scale-x-100',
        ].join(' ')}
      />
      <span
        aria-hidden="true"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-teal/60 transition-colors duration-300 ease-smooth group-hover:border-teal"
      >
        <span className="h-1 w-1 rounded-full bg-teal" />
      </span>
      {preparing ? 'Starting tour…' : 'Guided tour'}
    </button>
  )
}

/**
 * The active item is marked twice over: a teal rule that slides between items,
 * and the label going from light to white. The rule is a single element per
 * orientation rather than one per link, so it travels rather than blinking.
 */
function NavItems({ orientation }) {
  const vertical = orientation === 'vertical'
  return (
    <>
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            [
              'group relative transition-colors duration-300 ease-smooth',
              vertical
                ? 'block py-2.5 pl-[26px] pr-4 text-body'
                : 'shrink-0 px-1 py-3.5 text-body',
              isActive ? 'font-medium text-paper' : 'font-normal text-slate2-onDark hover:text-paper',
            ].join(' ')
          }
        >
          {({ isActive }) => (
            <>
              {/* The marker itself. It scales in from nothing rather than
                  appearing, so moving between items reads as one movement. */}
              <span
                aria-hidden="true"
                className={[
                  'absolute bg-teal transition-transform duration-300 ease-spring',
                  vertical
                    ? 'inset-y-1 left-0 w-[2px] origin-center'
                    : 'inset-x-0 bottom-0 h-[2px] origin-left',
                  isActive ? 'scale-100' : vertical ? 'scale-y-0' : 'scale-x-0',
                ].join(' ')}
              />
              {/* A hairline preview of that marker while the pointer is over it. */}
              <span
                aria-hidden="true"
                className={[
                  'absolute bg-paper/25 transition-transform duration-200 ease-smooth',
                  vertical
                    ? 'inset-y-1 left-0 w-[2px] origin-center scale-y-0 group-hover:scale-y-100'
                    : 'inset-x-0 bottom-0 h-[2px] origin-left scale-x-0 group-hover:scale-x-100',
                  isActive ? 'hidden' : '',
                ].join(' ')}
              />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </>
  )
}

/**
 * The Monocle diagonal behind the navy rail — a wash rather than a line.
 *
 * Drawn as a wide, low-opacity band instead of the hairline this started as: a
 * 1px red rule at full height read as a rendering artifact cutting through the
 * nav rather than as brand. At this weight it registers as a tint in the corner
 * and nothing more.
 */
function RailMotif() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute -right-24 top-0 h-[150%] w-[190px] -skew-x-[18deg] opacity-[0.55]"
        style={{
          background:
            'linear-gradient(to bottom, rgba(232,43,43,0.16), rgba(232,43,43,0.04) 45%, transparent 75%)',
        }}
      />
    </div>
  )
}

export default function App() {
  const [meta, setMeta] = useState(null)
  const { pathname } = useLocation()

  useEffect(() => {
    getMeta()
      .then((res) => setMeta(res.data))
      .catch(() => setMeta(null))
  }, [])

  const strap = (
    <p className="text-meta font-normal leading-4 text-slate2-onDark">
      Built by Tevin Richard
    </p>
  )

  // The chat route is an app shell: the viewport is the frame, and the transcript
  // scrolls inside it. `overflow-y-auto` needs a definite height to work against, so
  // this route gets `h-[100dvh]` while every other route keeps `min-h` and lets the
  // document scroll as normal.
  const isChat = pathname === '/'

  return (
    <div
      className={`bg-paper text-navy lg:flex ${
        isChat ? 'flex h-[100dvh] flex-col overflow-hidden lg:flex-row' : 'min-h-screen'
      }`}
    >
      {/* Below lg the rail becomes a header: lockup, then the same nav laid
          horizontally. The provenance block follows the content instead. */}
      <header className="relative shrink-0 bg-navy text-paper lg:hidden">
        <RailMotif />
        <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-gutter pt-5">
          <Brand />
          <div className="hidden sm:block">{strap}</div>
        </div>
        <nav data-tour="nav" className="scroll-slim relative flex gap-6 overflow-x-auto px-gutter">
          <NavItems orientation="horizontal" />
          <TourLaunch orientation="horizontal" />
        </nav>
        <div className="relative px-gutter pb-3 sm:hidden">{strap}</div>
      </header>

      <aside className="relative hidden w-nav shrink-0 bg-navy text-paper lg:sticky lg:top-0 lg:block lg:h-screen lg:overflow-y-auto">
        <RailMotif />
        <div className="relative flex min-h-full flex-col">
          <div className="px-gutter pb-2 pt-7">
            <Brand size="lg" />
            <div className="mt-3">{strap}</div>
          </div>

          <nav data-tour="nav" className="mt-7">
            <NavItems orientation="vertical" />
            <div className="mt-2 border-t border-navy-rule pt-2">
              <TourLaunch orientation="vertical" />
            </div>
          </nav>

          <div className="mt-auto px-gutter pb-7 pt-10">
            <Account className="border-t border-navy-rule pb-4 pt-3" />
            <div data-tour="run-context" className="border-t border-navy-rule pt-3">
              <RunContext meta={meta} className="text-meta font-normal" />
            </div>
          </div>
        </div>
      </aside>

      <main className={`min-w-0 flex-1 ${isChat ? 'flex min-h-0 flex-col overflow-hidden' : ''}`}>
        <div
          key={pathname}
          className={
            isChat
              ? 'screen-in flex min-h-0 flex-1 flex-col px-gutter'
              : 'screen-in mx-auto w-full max-w-[1360px] px-gutter py-8 lg:py-12'
          }
        >
          <ErrorBoundary key={pathname}>
            <Routes>
              <Route path="/" element={<Ask meta={meta} />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/audit/:runId" element={<AuditDetail />} />
              <Route path="/corpus" element={<Corpus />} />
              <Route path="/evals" element={<Evals />} />
              <Route path="/help" element={<Help />} />
            </Routes>
          </ErrorBoundary>
        </div>

        <div className={`relative bg-navy px-gutter py-5 text-paper lg:hidden ${isChat ? 'hidden' : ''}`}>
          <RailMotif />
          <div className="relative">
            <p className="eyebrow-dark">Run context</p>
            <RunContext meta={meta} className="mt-2 text-meta font-normal" />
            <Account className="mt-5 border-t border-navy-rule pt-3" />
          </div>
        </div>
      </main>
    </div>
  )
}
