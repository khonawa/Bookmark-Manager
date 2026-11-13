import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './compact.css'
import App from './Workspace.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
