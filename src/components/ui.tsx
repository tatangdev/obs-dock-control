// Shared visual primitives — single source for fragments that were
// copy-pasted between the dock and remote pages.

/** Standard text input */
export const inputCls =
  'w-full rounded-xl border border-transparent bg-ios-fill px-3 py-2 text-base sm:text-sm text-white outline-none focus:border-ios-blue'

/** Full-width primary action button */
export const primaryBtnCls =
  'w-full rounded-xl bg-ios-blue active:scale-[0.98] transition-all duration-200 ease-out px-3 py-2.5 text-base sm:text-sm font-semibold text-white hover:bg-ios-blue-light disabled:opacity-50'

/**
 * Live audio peak bar (green → orange → red). Pass sizing/layout classes;
 * the caller feeds it dBFS peaks from watchMeters.
 */
export function LevelMeter({ peakDb, className }: { peakDb: number; className: string }) {
  const pct = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100))
  const color = peakDb > -6 ? 'bg-ios-red' : peakDb > -18 ? 'bg-ios-orange' : 'bg-ios-green'
  return (
    <div className={`overflow-hidden rounded-full bg-ios-fill ${className}`} title="Live input level">
      <div className={`h-full rounded-full transition-[width] duration-75 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
