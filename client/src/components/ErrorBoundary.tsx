import { Component, ReactNode } from 'react';

// Catches render crashes in a subtree so one broken page never blanks the whole
// app. Shows the error text (useful for diagnosis) + a reset button.
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: unknown) { console.error('[ErrorBoundary]', error, info); }
  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="card m-2 p-6">
          <div className="text-base font-semibold text-red-600">Something went wrong on this page.</div>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-700">{this.state.error.message}</pre>
          <div className="mt-3 flex gap-2">
            <button className="btn-primary" onClick={this.reset}>Try again</button>
            <button className="btn-outline" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
