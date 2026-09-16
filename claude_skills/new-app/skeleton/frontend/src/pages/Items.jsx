import { useState, useEffect } from 'react'
import { getItems, createItem } from '../api'

export default function Items() {
  const [items, setItems] = useState([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true)
    getItems()
      .then((res) => setItems(res.data))
      .catch(() => setError('Failed to load items.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const submit = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    createItem({ name, description })
      .then(() => {
        setName('')
        setDescription('')
        setError(null)
        load()
      })
      .catch(() => setError('Failed to create item.'))
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Items</h1>

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          className="flex-1 rounded border border-slate-300 px-3 py-2"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="flex-1 rounded border border-slate-300 px-3 py-2"
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button className="rounded bg-slate-900 px-4 py-2 text-white" type="submit">
          Add
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500">No items yet. Add one above.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {items.map((it) => (
            <li key={it.id} className="px-4 py-3">
              <p className="font-medium">{it.name}</p>
              {it.description && <p className="text-sm text-slate-500">{it.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
