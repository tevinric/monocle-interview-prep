import axios from 'axios'
import { authMode, getAccessToken, reauthenticate } from './auth'

// In production the nginx proxy serves the API from the same origin, so baseURL
// is empty. In local `npm run dev` it points at the backend via VITE_LENS_API_URL.
export const apiBaseUrl = import.meta.env.PROD
  ? ''
  : (import.meta.env.VITE_LENS_API_URL || 'http://localhost:5100')

const api = axios.create({ baseURL: apiBaseUrl })

/**
 * Every call carries the access token, and the token is fetched per call rather than
 * held here: MSAL is the only thing that knows whether the one it has is still valid,
 * and asking it each time is what makes a silent renewal invisible. In DEV the API
 * reports mode 'open', getAccessToken returns null, and no header is sent at all.
 */
async function authHeaders(existing = {}) {
  const token = await getAccessToken()
  return token ? { ...existing, Authorization: `Bearer ${token}` } : existing
}

api.interceptors.request.use(async (config) => {
  config.headers = await authHeaders(config.headers)
  return config
})

// A 401 from the API after a silent renewal has already been tried means the session is
// over rather than stale. 403 is left alone: that is the API saying this account may not
// do this, and signing in again would not change it.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401 && authMode() === 'entra') reauthenticate()
    return Promise.reject(error)
  },
)

export const healthCheck = () => api.get('/api/health')
export const getMeta = () => api.get('/api/meta')
export const getRuns = (params = {}) => api.get('/api/runs', { params })
export const getRun = (id) => api.get(`/api/runs/${id}`)
// The same history as getRuns, grouped into the threads the questions were asked in.
export const getConversations = (params = {}) => api.get('/api/conversations', { params })
export const getConversation = (id) => api.get(`/api/conversations/${id}`)
export const getChunkContext = (id) => api.get(`/api/chunks/${id}/context`)
export const getCorpus = () => api.get('/api/corpus')
export const getEvals = (params = {}) => api.get('/api/evals', { params })
export const getPrompts = () => api.get('/api/prompts')

/**
 * The audit pack, downloaded rather than linked.
 *
 * A plain <a download> cannot carry an Authorization header, so with sign-in enforced
 * the link would simply 401. Fetching it and handing the browser a blob keeps the export
 * behind the same gate as everything else it contains.
 */
export async function downloadExport(id) {
  const response = await fetch(`${apiBaseUrl}/api/runs/${id}/export`, {
    headers: await authHeaders({ Accept: 'application/json' }),
  })
  if (!response.ok) {
    if (response.status === 401 && authMode() === 'entra') reauthenticate()
    throw new Error(`The audit pack could not be exported (${response.status}).`)
  }
  const blob = await response.blob()
  const name = /filename="?([^";]+)"?/.exec(response.headers.get('Content-Disposition') || '')?.[1]
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name || `lens-audit-${id}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: Safari has not finished reading the blob when click()
  // returns, and a revoked URL there downloads an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// Server-Sent Events: axios has no browser streaming, so these two use fetch against
// the same baseURL. Every other call goes through the axios instance above.
async function streamSSE(path, body, onEvent, signal) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
    signal,
  })
  if (!response.ok || !response.body) {
    if (response.status === 401 && authMode() === 'entra') reauthenticate()
    throw new Error(`Request failed (${response.status})`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop()
    for (const frame of frames) {
      let event = 'message'
      const data = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trim())
      }
      if (data.length) onEvent(event, JSON.parse(data.join('\n')))
    }
  }
}

// `history` is the recent thread, so a follow-up can be resolved against it. The backend
// keeps the last MEMORY_TURNS messages and no more; sending fewer is always safe.
export const streamChat = (body, onEvent, signal) => streamSSE('/api/chat', body, onEvent, signal)
// mode 'reproduce' re-executes the pipeline against the model responses this run
// recorded, so the answer must come out identical. mode 'live' asks the question again
// against the current prompts, where a difference is the point.
export const streamReplay = (id, mode, onEvent, signal) =>
  streamSSE(`/api/runs/${id}/replay?mode=${mode}`, { mode }, onEvent, signal)

// Scores the whole question set. Minutes, not seconds, so it reports progress as it goes.
export const streamEvalRun = (onEvent, signal) => streamSSE('/api/evals/run', {}, onEvent, signal)

export default api
