import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ResourceAllocationApp from './ResourceAllocationApp'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ResourceAllocationApp />
  </StrictMode>,
)
