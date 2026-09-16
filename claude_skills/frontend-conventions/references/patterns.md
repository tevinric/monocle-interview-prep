# Frontend patterns (copy-paste)

The scaffolded `Items` page and `api.js` are the canonical example.

## Add API calls (src/api.js)

```js
export const getThings   = (params = {}) => api.get('/api/things', { params })
export const getThing    = (id)          => api.get(`/api/things/${id}`)
export const createThing = (data)        => api.post('/api/things', data)
export const updateThing = (id, data)    => api.put(`/api/things/${id}`, data)
export const deleteThing = (id)          => api.delete(`/api/things/${id}`)
```

The shared `api` instance (top of the file) sets `baseURL` and is reused by every
call — don't re-create it.

## A page component (src/pages/Things.jsx)

```jsx
import { useState, useEffect } from 'react'
import { getThings, createThing } from '../api'

export default function Things() {
  const [things, setThings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true)
    getThings()
      .then((res) => setThings(res.data))
      .catch(() => setError('Failed to load.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  if (loading) return <p className="text-slate-500">Loading…</p>
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Things</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {/* render things */}
    </div>
  )
}
```

## Wire it into the shell (src/App.jsx)
1. `import Things from './pages/Things'`
2. Add `<Route path="/things" element={<Things />} />` inside `<Routes>`.
3. Add a `<Link to="/things">Things</Link>` in the nav if it should be reachable.

## Checklist for any new screen
- [ ] Component in `pages/`, default-exported, PascalCase.
- [ ] All HTTP via a named export in `api.js` (no direct axios/fetch).
- [ ] Route (and nav link) added in `App.jsx`.
- [ ] New `VITE_` var (if any) added to `frontend/.env.example`; rebuild to apply.
- [ ] `npm run lint` clean of errors.
