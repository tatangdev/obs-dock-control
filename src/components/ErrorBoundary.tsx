import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// Last line of defense: a render crash shows a recoverable screen instead of
// a blank page (especially important inside an OBS dock, where there are no
// devtools open to hint at what happened).
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render crash:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-sm p-4 pt-10">
        <h1 className="mb-2 text-lg font-semibold">Something went wrong</h1>
        <p className="mb-1 text-sm text-zinc-400">The app hit an unexpected error and stopped rendering.</p>
        <p className="mb-4 break-all font-mono text-xs text-red-400">{this.state.error.message}</p>
        <button
          onClick={() => location.reload()}
          className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm font-semibold text-zinc-100 hover:bg-zinc-700"
        >
          Reload
        </button>
      </div>
    )
  }
}
