import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// Handheld cutoff: below this (smaller viewport side) the UI zooms up a bit
// so touch targets land at native-app sizes.
const PHONE_MAX = 500
const PHONE_REF_W = 360
const PHONE_MAX_SCALE = 1.3

function computeScale(): number {
  const minSide = Math.min(window.innerWidth, window.innerHeight)
  if (minSide >= PHONE_MAX) return 1
  return Math.min(PHONE_MAX_SCALE, Math.max(1, minSide / PHONE_REF_W))
}

// Full-viewport app shell. The UI is responsive (the sidebar stacks below the
// controls on narrow viewports); phones additionally get a mild zoom.
export default function Stage({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState<number>(computeScale)

  useEffect(() => {
    const onResize = (): void => setScale(computeScale())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div className="min-h-dvh w-full bg-black" style={scale > 1 ? { zoom: scale } : undefined}>
      {children}
    </div>
  )
}
