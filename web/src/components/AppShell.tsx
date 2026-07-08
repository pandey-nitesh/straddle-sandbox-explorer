import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Wordmark } from "./Wordmark";

/**
 * Single-screen shell (design §5): 56px header, scenario nav + lifecycle +
 * wide wire inspector, summary strip, unaffiliation footer line.
 * Panes are placeholder slots — Stage 2 fills them with the live components.
 */
export interface AppShellProps {
  scenarios?: ReactNode;
  lifecycle?: ReactNode;
  wire?: ReactNode;
  summary?: ReactNode;
  keyStatus?: "ok" | "missing" | "invalid";
  /** Consecutive poll cycles failed — the server is unreachable. */
  offline?: boolean;
  onRunAll?: () => void;
  /** Learning-layer toggle (design §6.6); the button renders only when wired. */
  explainEnabled?: boolean;
  onToggleExplain?: () => void;
}

export function PrimaryButton({
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  // The one primary button style (design §6.5): accent fill, white text,
  // radius 8px, weight 500 — used only for Run all / Run / Download report.json.
  return (
    <button
      type="button"
      {...rest}
      className="chip-transition rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Pane({
  title,
  live,
  children,
}: {
  title: string;
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      aria-live={live === true ? "polite" : undefined}
      className="flex min-h-0 flex-col overflow-hidden rounded-card bg-surface-card p-4 shadow-card"
    >
      <h2 className="pane-header">{title}</h2>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-muted">{children}</p>;
}

export function AppShell(props: AppShellProps) {
  const keyStatus = props.keyStatus ?? "ok";
  return (
    <div className="flex h-full min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-surface-card px-6">
        <Wordmark />
        {/* Accent-outline chip — a quiet echo of the hard-coded sandbox base URL. */}
        <span className="wire-quote rounded-chip border border-accent px-2 py-0.5 text-xs text-accent">
          sandbox
        </span>
        <span
          data-status={keyStatus}
          className={`wire-quote rounded-chip border px-2 py-0.5 text-xs ${
            keyStatus === "ok"
              ? "border-status-pass text-status-pass"
              : "border-status-fail text-status-fail"
          }`}
        >
          key {keyStatus}
        </span>
        {props.offline === true && (
          <span
            data-testid="offline-chip"
            className="wire-quote rounded-chip border border-status-fail bg-status-fail/10 px-2 py-0.5 text-xs text-status-fail"
          >
            server unreachable
          </span>
        )}
        <span className="flex-1" />
        {props.onToggleExplain !== undefined && (
          <button
            type="button"
            aria-pressed={props.explainEnabled === true}
            title="Explanations for statuses, return codes, outcomes, and API calls — click any underlined term"
            onClick={props.onToggleExplain}
            className={`chip-transition rounded-lg border px-3 py-1 text-sm font-medium ${
              props.explainEnabled === true
                ? "border-accent bg-accent/10 text-accent-strong"
                : "border-edge text-fg-muted hover:border-edge-strong"
            }`}
          >
            Explain{" "}
            <span className="wire-quote text-xs">
              {props.explainEnabled === true ? "on" : "off"}
            </span>
          </button>
        )}
        <PrimaryButton onClick={props.onRunAll}>Run all</PrimaryButton>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 xl:grid-cols-[280px_minmax(280px,0.6fr)_minmax(620px,1.4fr)] xl:p-6">
        <Pane title="Scenarios">
          {props.scenarios ?? <Placeholder>Scenarios A–E load here.</Placeholder>}
        </Pane>
        <Pane title="Lifecycle" live>
          {props.lifecycle ?? (
            <div className="space-y-2">
              <Placeholder>
                No runs yet. Run scenario C to watch a payment settle and then
                un-settle.
              </Placeholder>
              {props.explainEnabled === true && (
                <Placeholder>
                  Explain is on: click any dotted-underlined term — like a
                  scenario&apos;s{" "}
                  <span className="wire-quote">sandbox_outcome</span> — to
                  learn what it does.
                </Placeholder>
              )}
            </div>
          )}
        </Pane>
        <Pane title="Wire">
          {props.wire ?? <Placeholder>No exchanges yet.</Placeholder>}
        </Pane>
      </main>

      <footer className="shrink-0 border-t border-edge bg-surface-card px-6 py-3">
        {/* The summary slot owns the whole strip (RunSummary brings its own
            Download button); the fallback covers the empty pre-run state. */}
        {props.summary ?? (
          <div className="flex items-center justify-between gap-4">
            <span className="wire-quote text-fg-muted">no runs yet</span>
            <PrimaryButton disabled>Download report.json</PrimaryButton>
          </div>
        )}
        <p className="mt-2 text-xs text-fg-muted">
          Unofficial developer demo — not affiliated with Straddle Payments Inc.
        </p>
      </footer>
    </div>
  );
}
