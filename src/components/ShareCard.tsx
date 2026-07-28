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
  const [urlShown, setUrlShown] = useState(false)

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
        // fall back to showing the link so select-and-copy still works.
        setUrlShown(true)
      })
  }

  return (
    <div className="mb-4 animate-fade-in rounded-2xl border border-transparent bg-ios-card px-3 py-3">
      <div className="flex items-center gap-3 sm:gap-4">
        <div className="shrink-0 rounded-lg bg-white p-2">
          <QRCodeSVG value={url} size={104} marginSize={0} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">Scan to join</div>
          <p className="mt-0.5 text-xs text-ios-label2">Point a phone camera here — the remote opens connected.</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ios-label2">
            {pin === null ? (
              <span className="text-ios-orange">PIN not stored — restart the session to embed it.</span>
            ) : (
              <span>
                Typing instead? PIN{' '}
                <button
                  onClick={() => setPinShown((v) => !v)}
                  title={pinShown ? 'Hide the PIN' : 'Show the PIN'}
                  className="font-mono font-semibold text-ios-blue transition-colors hover:text-ios-blue-light"
                >
                  {pinShown ? pin : '••••'}
                </button>
              </span>
            )}
            <button onClick={copy} className="font-medium text-ios-blue transition-colors hover:text-ios-blue-light">
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          {urlShown && (
            <div className="mt-1.5">
              <span className="block select-all truncate rounded-lg bg-ios-fill px-2 py-1 font-mono text-xs text-ios-label2">
                {url}
              </span>
            </div>
          )}
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
