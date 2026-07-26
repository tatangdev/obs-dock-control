import type { ReactNode } from 'react'

// Centered single-card layout used by every pre-session screen (connect,
// start, join, ended).
export default function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl sm:text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm sm:text-xs text-ios-label3">{subtitle}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
