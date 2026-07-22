import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import Stage from './components/Stage'
import Home from './pages/Home'
import Dock from './pages/Dock'
import Remote from './pages/Remote'

export default function App() {
  return (
    <ErrorBoundary>
      <Stage>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/dock" element={<Dock />} />
            <Route path="/remote" element={<Remote />} />
          </Routes>
        </BrowserRouter>
      </Stage>
    </ErrorBoundary>
  )
}
