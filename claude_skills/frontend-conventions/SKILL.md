---
name: frontend-conventions
description: Conventions for this stack's React + Vite + Tailwind frontend (frontend/src). Auto-loads when editing frontend files. Covers pages/components, the api.js layer, env vars, and styling.
paths:
  - "frontend/**"
  - "**/frontend/**"
---

# Frontend conventions (React + Vite + Tailwind)

Standing rules for everything under `frontend/src/`. React 18 + React Router 6 +
Tailwind, bundled by Vite, served by nginx in production. The scaffolded `Items`
page + `api.js` are the reference example.

## File layout
- **`src/pages/`** — one component per route screen (PascalCase, default-exported).
- **`src/components/`** — reusable presentational components (PascalCase).
- **`src/api.js`** — the single axios layer. **All** HTTP calls go through here.
- **`src/App.jsx`** — shell, nav links, `<Routes>`. **`src/main.jsx`** — bootstrap.
- New screen = new file in `pages/`, imported and added as a `<Route>` in `App.jsx`
  (and a nav `<Link>` if it should be reachable).

## Data fetching — always via `src/api.js`
- Never call `axios`/`fetch` directly from a component. Add a named export to
  `api.js` and import it: `import { getThings } from '../api'`.
- The shared `api` instance sets `baseURL` (empty in PROD so nginx proxies
  same-origin; `VITE_<PREFIX>_API_URL` in dev). Reuse it; don't create another.
- Follow the existing style:
  `export const getThings = (params = {}) => api.get('/api/things', { params })`.

## Environment variables
- Only `VITE_`-prefixed vars reach the browser, read via
  `import.meta.env.VITE_<PREFIX>_NAME`. They are **baked at build time** from
  `frontend/.env` — rebuild after changing them.
- New var → add to `frontend/.env.example`. Never put secrets in `VITE_` vars; they
  ship to the browser.

## Styling
- Tailwind utility classes in JSX (config in `tailwind.config.js`). Keep to the
  existing utility-composition style; no CSS modules / styled-components. Define a
  brand color scale in the Tailwind theme rather than hard-coding hex if you add one.

## Linting
- `npm run lint` (ESLint, config in `frontend/.eslintrc.cjs`) gates on **errors**.
  `react-hooks/exhaustive-deps` is a warning — fix it by genuinely correcting the
  dependency array, never by mechanically adding deps that cause render loops.

## Optional add-ons (not in the minimal core)
- **Auth:** the core has no login. If you add Entra/MSAL, wrap the app in
  `main.jsx`, gate in `App.jsx` (with a `DEV`/`PROD` bypass toggle), and inject the
  auth header in the `api.js` request interceptor — don't gate inside pages.

Copy-paste templates: [references/patterns.md](references/patterns.md).
