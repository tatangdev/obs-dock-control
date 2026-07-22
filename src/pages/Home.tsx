import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">OBS Dock Control</h1>
        <p className="mt-2 text-ios-label2">
          Two-camera layout switching for OBS — run the dock next to your stream, drive it from anywhere.
        </p>
      </div>

      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        <Link
          to="/dock"
          className="rounded-2xl border border-transparent bg-ios-card p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-ios-blue"
        >
          <div className="text-lg font-semibold">Dock (Server)</div>
          <p className="mt-1 text-sm text-ios-label2">
            Add this page as a custom browser dock inside OBS. It connects to OBS, guides first-time setup, and hosts
            the session remotes join.
          </p>
        </Link>
        <Link
          to="/remote"
          className="rounded-2xl border border-transparent bg-ios-card p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-ios-blue"
        >
          <div className="text-lg font-semibold">Remote</div>
          <p className="mt-1 text-sm text-ios-label2">
            Enter the session code and PIN to switch layouts and control the stream from a phone, tablet, or another
            computer.
          </p>
        </Link>
      </div>

      <p className="max-w-md text-center text-xs text-ios-label3">
        In OBS: Docks → Custom Browser Docks → add this site&apos;s <code>/dock</code> URL.
      </p>
    </div>
  )
}
