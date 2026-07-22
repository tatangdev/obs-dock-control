import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// Below this size the UI starts to shrink instead of cropping/scrolling.
const REF_W = 420
const REF_H = 460

interface Dims {
  w: number
  h: number
  scale: number
}

function compute(): Dims {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(vw, (vh * 16) / 9)
  const h = Math.min(vh, (vw * 9) / 16)
  return { w, h, scale: Math.min(1, w / REF_W, h / REF_H) }
}

// Letterboxed 16:9 stage, like an OBS canvas: the app always renders inside
// the largest 16:9 rectangle that fits the viewport. Whatever space is left
// over stays empty — bars top/bottom on tall windows, left/right on wide ones.
// On small canvases the content zooms down proportionally so it fits instead
// of being cropped: layout size is w/scale × h/scale, rendered back at w × h.
export default function Stage({ children }: { children: ReactNode }) {
  const [dims, setDims] = useState<Dims>(compute)

  useEffect(() => {
    const onResize = (): void => setDims(compute())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div className="grid h-dvh w-screen place-items-center bg-black">
      <div
        className="overflow-y-auto bg-black ring-1 ring-ios-sep"
        style={{ width: dims.w / dims.scale, height: dims.h / dims.scale, zoom: dims.scale }}
      >
        {children}
      </div>
    </div>
  )
}
