import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import AuthGate from './AuthGate.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Nothing below this mounts until the API has said whether a sign-in is needed,
          and — where one is — until there is an account. */}
      <AuthGate>
        <App />
      </AuthGate>
    </BrowserRouter>
  </React.StrictMode>,
)
