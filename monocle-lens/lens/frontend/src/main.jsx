import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import AuthGate from './AuthGate.jsx'
import TourProvider from './tour/TourProvider.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Nothing below this mounts until the API has said whether a sign-in is needed,
          and — where one is — until there is an account. */}
      <AuthGate>
        {/* Inside the gate so the tour knows who signed in, and inside the router so it
            can walk them through the application. */}
        <TourProvider>
          <App />
        </TourProvider>
      </AuthGate>
    </BrowserRouter>
  </React.StrictMode>,
)
