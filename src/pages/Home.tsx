import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">OBS Dock Control</h1>
        <p className="mt-2 text-zinc-400">Control OBS from anywhere — dock on the streaming PC, remote on any device.</p>
      </div>

      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        <Link
          to="/dock"
          className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 transition-colors hover:border-emerald-600"
        >
          <div className="text-lg font-semibold">Dock (Server)</div>
          <p className="mt-1 text-sm text-zinc-400">
            Open this inside OBS as a custom browser dock. Connects to OBS and hosts a session.
          </p>
        </Link>
        <Link
          to="/remote"
          className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 transition-colors hover:border-sky-600"
        >
          <div className="text-lg font-semibold">Remote</div>
          <p className="mt-1 text-sm text-zinc-400">
            Join a session with its code and PIN from your phone, tablet, or another computer.
          </p>
        </Link>
      </div>

      <p className="max-w-md text-center text-xs text-zinc-500">
        In OBS: Docks → Custom Browser Docks → add this site&apos;s <code>/dock</code> URL.
      </p>
    </div>
  )
}
