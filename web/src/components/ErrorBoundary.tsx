import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Per-pane error isolation (P2-R.5). A render error in one pane's projection
 * must not blank the whole screen mid-demo — the boundary catches it, shows a
 * quiet "this panel hit an error" card in the design register, and leaves every
 * other pane live. Reload restores the crashed pane (state re-hydrates from the
 * server, so nothing is lost).
 *
 * Error boundaries must be class components — this is the one class in web/.
 */
interface ErrorBoundaryProps {
  /** Pane name, for the logged diagnostic. */
  label?: string;
  children: ReactNode;
  /** Optional injected reload (tests); defaults to window.location.reload. */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `pane error${this.props.label === undefined ? "" : ` (${this.props.label})`}`,
      error,
      info.componentStack,
    );
  }

  private readonly reload = (): void => {
    if (this.props.onReload !== undefined) this.props.onReload();
    else window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div role="alert" className="rounded-lg bg-surface-inset p-4 text-sm">
        <p className="font-medium text-fg">This panel hit an error.</p>
        <p className="mt-1 text-fg-muted">
          The rest of the screen is still live. Reload to restore this panel.
        </p>
        <button
          type="button"
          onClick={this.reload}
          className="chip-transition mt-3 rounded-lg border border-edge px-3 py-1 text-sm text-fg-secondary hover:border-edge-strong"
        >
          Reload
        </button>
      </div>
    );
  }
}
