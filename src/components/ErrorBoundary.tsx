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
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center p-4">
        <h1 className="mb-2 text-xl sm:text-lg font-semibold">Something went wrong</h1>
        <p className="mb-1 text-base sm:text-sm text-ios-label2">
          The app hit an unexpected error and stopped rendering.
        </p>
        <p className="mb-4 break-all font-mono text-sm sm:text-xs text-ios-red">{this.state.error.message}</p>
        <button
          onClick={() => location.reload()}
          className="w-full rounded-xl bg-ios-fill active:scale-[0.98] transition-all duration-200 ease-out px-3 py-2.5 text-base sm:text-sm font-semibold text-white hover:bg-ios-fill2"
        >
          Reload
        </button>
      </div>
    )
  }
}
