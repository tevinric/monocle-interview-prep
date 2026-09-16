import { Component } from 'react'

/**
 * The last line of defence against a blank page.
 *
 * Without this, one bad field in an API response unmounts the whole tree and the
 * browser shows white — which, in front of a room, is indistinguishable from the
 * stack being down. This keeps the chrome and says what broke.
 *
 * Only for render-time faults. Anything expected — a failed fetch, an empty
 * corpus — is handled where it happens and states its own case.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Kept on the console rather than surfaced: the person reading the screen
    // needs the recovery, whoever is debugging needs the component stack.
    console.error('Lens: a screen failed to render.', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="panel border-l-[3px] border-l-brand-red p-6 sm:p-8">
        <p className="eyebrow">Something on this screen failed to render</p>
        <h2 className="section-heading mt-3">The rest of Lens is still running.</h2>
        <p className="mt-3 max-w-measure font-serif text-quote text-slate2">
          This is a fault in the interface, not in the agent or its record — nothing that
          has been run is lost. Reload the page, or use the navigation to move elsewhere.
          The details are on the browser console.
        </p>
        <p className="mt-4 font-mono text-json text-slate2-light">
          {String(this.state.error?.message || this.state.error)}
        </p>
        <button type="button" className="btn mt-5" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
