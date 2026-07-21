import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/authContext'
import App from './App'
import './index.css'

const releaseSha = import.meta.env.VITE_RELEASE_SHA ?? ''
if (/^[0-9a-f]{40}$/.test(releaseSha)) {
  document.documentElement.dataset.releaseSha = releaseSha
}

// Mount the app with BrowserRouter and AuthProvider wrapping the root
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
