import React from 'react';

/**
 * Crash barrier around the active page. A rendering error in any single
 * tab must NEVER black-screen the whole dashboard — it renders an error
 * card with the failure details and a retry button instead, and the rest
 * of the app (sidebar, header, other tabs) keeps working.
 */

interface Props {
  /** Changes when the user navigates — resets the boundary so a crashed
   *  tab doesn't poison every other tab. */
  pageKey: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class PageErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // Surface the crash to the server log so it's diagnosable after the fact.
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: this.props.pageKey,
        message: error.message,
        stack: (error.stack ?? '').slice(0, 2000),
        componentStack: (info.componentStack ?? '').slice(0, 2000),
      }),
    }).catch(() => { /* best-effort */ });
  }

  componentDidUpdate(prev: Props): void {
    if (prev.pageKey !== this.props.pageKey && this.state.error) {
      this.setState({ error: null, componentStack: null });
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: '32px', maxWidth: 720 }}>
        <div style={{
          border: '1px solid #da3633', borderRadius: 8, padding: '20px 24px',
          background: 'rgba(218,54,51,0.08)',
        }}>
          <h2 style={{ color: '#f85149', marginBottom: 8 }}>This tab hit an error</h2>
          <p style={{ color: 'var(--text-secondary, #8b949e)', marginBottom: 12 }}>
            The rest of AgentX is unaffected — switch tabs or retry. The details
            below have been logged for diagnosis.
          </p>
          <pre style={{
            fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto',
            background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 6,
            color: '#f0f6fc', maxHeight: 220,
          }}>
            {this.state.error.message}
            {this.state.componentStack ? `\n${this.state.componentStack.split('\n').slice(0, 8).join('\n')}` : ''}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null, componentStack: null })}
            style={{
              marginTop: 12, padding: '8px 18px', borderRadius: 6,
              border: '1px solid var(--color-border, #30363d)',
              background: 'var(--color-bg-secondary, #161b22)',
              color: 'var(--text-primary, #f0f6fc)', cursor: 'pointer',
            }}
          >
            Retry this tab
          </button>
        </div>
      </div>
    );
  }
}
