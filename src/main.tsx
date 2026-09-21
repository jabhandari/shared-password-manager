import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'

const darkMode = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => { document.documentElement.dataset.theme = darkMode.matches ? 'dark' : 'light' }
applyTheme()
darkMode.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
