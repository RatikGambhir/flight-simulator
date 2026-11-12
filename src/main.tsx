import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Scripted performance benchmark (scripts/bench.mjs); a separate lazy chunk.
if (/[?&]bench=/.test(location.search)) void import('./dev/bench')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
