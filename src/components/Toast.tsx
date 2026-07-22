// Transient error notice, pinned to the bottom of the viewport. The caller
// owns dismissal (usually an auto-clear timeout).
export default function Toast({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-lg border border-red-800/60 bg-red-950/90 px-4 py-2.5 text-sm text-red-200 shadow-lg backdrop-blur"
    >
      {message}
    </div>
  )
}
