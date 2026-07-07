import type { ReactNode } from "react";
import { Wordmark } from "./Wordmark";

/**
 * Full-screen startup states replacing the app (design §6.4, spec §10).
 * Centered single card, max-width 420px. Errors explain and instruct;
 * they never apologize and never stack-trace.
 */
export type StartupStateProps =
  | { state: "checking" }
  | { state: "missing" }
  | { state: "invalid"; errorBody?: unknown };

const ENV_COMMAND = "cp .env.example .env";

function StartupCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-surface-app p-6">
      <div className="w-full max-w-[420px] rounded-card bg-surface-card p-8 shadow-card">
        {children}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="chip-transition shrink-0 rounded-lg border border-edge bg-surface-card px-2 py-1 text-xs font-medium text-fg-secondary hover:border-edge-strong"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
    >
      Copy
    </button>
  );
}

export function StartupState(props: StartupStateProps) {
  if (props.state === "checking") {
    return (
      <StartupCard>
        <div className="flex items-center gap-3">
          <span
            aria-label="Checking the sandbox connection"
            role="status"
            className="startup-spinner inline-block size-4 rounded-full border-2 border-edge border-t-accent"
          />
          <Wordmark />
        </div>
      </StartupCard>
    );
  }

  if (props.state === "missing") {
    return (
      <StartupCard>
        <h1 className="text-[1.125rem] font-semibold text-fg">
          Add your sandbox API key
        </h1>
        <p className="mt-3 text-sm text-fg-secondary">
          Create a sandbox key in{" "}
          <span className="wire-quote">dashboard.straddle.com</span> under API
          keys, then copy the example env file and paste the key into{" "}
          <span className="wire-quote">STRADDLE_API_KEY</span>:
        </p>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-inset bg-surface-inset px-3 py-2">
          <code className="wire-quote text-fg">{ENV_COMMAND}</code>
          <CopyButton text={ENV_COMMAND} />
        </div>
        <p className="mt-3 text-sm text-fg-secondary">
          Restart the server after saving.
        </p>
      </StartupCard>
    );
  }

  return (
    <StartupCard>
      <h1 className="text-[1.125rem] font-semibold text-fg">
        Straddle rejected this key
      </h1>
      {/* M0 (spec §18.5): the sandbox 401 body is empty — show the status
          line; if a body is ever present, render it verbatim instead. */}
      {props.errorBody === undefined ? (
        <p className="wire-quote mt-3 text-fg-secondary">
          401 · no response body
        </p>
      ) : (
        <pre className="wire-quote mt-3 overflow-x-auto rounded-inset bg-surface-inset p-3 text-xs leading-[1.6] text-fg">
          {JSON.stringify(props.errorBody, null, 2)}
        </pre>
      )}
      <p className="mt-3 text-sm text-fg-secondary">
        Regenerate the key in{" "}
        <span className="wire-quote">dashboard.straddle.com</span> under API
        keys, update <span className="wire-quote">.env</span>, and restart the
        server.
      </p>
    </StartupCard>
  );
}
