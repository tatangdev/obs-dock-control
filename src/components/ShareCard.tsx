import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

/** Link a remote can open to join with nothing to type (PIN omitted if unknown) */
function joinUrl(code: string, pin: string | undefined): string {
  const url = new URL('/remote', window.location.origin)
  url.searchParams.set('code', code)
  if (pin) url.searchParams.set('pin', pin)
  return url.toString()
}

// Scannable join card: the QR encodes /remote?code=…&pin=… so a phone camera
// lands on the remote already connected — nothing to type at the venue.
export default function ShareCard({ code, pin }: { code: string; pin: string | null }) {
  const url = joinUrl(code, pin ?? undefined)
  const [copied, setCopied] = useState(false)
  const [pinShown, setPinShown] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  function copy(): void {
    navigator.clipboard
      .writeText(url)
      .then(() => setCopied(true))
      .catch(() => {
        // Clipboard is unavailable in some embedded browsers (the OBS dock) —
        // select-and-copy from the visible link still works.
      })
  }

  return (
    <div className="mb-4 animate-fade-in rounded-2xl border border-transparent bg-ios-card px-4 py-4">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="shrink-0 rounded-xl bg-white p-3">
          <QRCodeSVG value={url} size={148} marginSize={0} />
        </div>
        <div className="min-w-0 text-center sm:text-left">
          <div className="text-base sm:text-sm font-semibold text-white">Scan to join</div>
          <p className="mt-1 text-sm sm:text-xs text-ios-label2">
            Point the phone camera here — it opens the remote already connected, no code or PIN to type.
          </p>
          {pin === null ? (
            <p className="mt-1 text-sm sm:text-xs text-ios-orange">
              The PIN isn&apos;t stored for this session, so scanners still type the PIN. Restart the session to embed
              it.
            </p>
          ) : (
            <p className="mt-1 text-sm sm:text-xs text-ios-label2">
              Typing instead? Code <span className="font-mono font-semibold text-white">{code}</span> · PIN{' '}
              <button
                onClick={() => setPinShown((v) => !v)}
                title={pinShown ? 'Hide the PIN' : 'Show the PIN'}
                className="font-mono font-semibold text-ios-blue transition-colors hover:text-ios-blue-light"
              >
                {pinShown ? pin : '••••'}
              </button>
            </p>
          )}
          <div className="mt-2 flex items-center justify-center gap-2 sm:justify-start">
            <span className="min-w-0 select-all truncate rounded-lg bg-ios-fill px-2 py-1 font-mono text-sm sm:text-xs text-ios-label2">
              {url}
            </span>
            <button
              onClick={copy}
              className="shrink-0 text-sm sm:text-xs font-medium text-ios-blue transition-colors hover:text-ios-blue-light"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
      <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v3h-3v-3zm-5 0h3v3h-3v-3zm0 5h3v3h-3v-3zm5 0h3v3h-3v-3z" />
    </svg>
  )
}
