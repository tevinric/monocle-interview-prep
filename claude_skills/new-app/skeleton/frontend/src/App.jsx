import { Routes, Route, Link } from 'react-router-dom'
import Items from './pages/Items'

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3">
          <span className="font-bold">@@NAME@@</span>
          <Link to="/" className="text-sm text-slate-600 hover:text-slate-900">
            Items
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Items />} />
        </Routes>
      </main>
    </div>
  )
}
