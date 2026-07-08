import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { StartupState } from "./components/StartupState";
import { getHealth } from "./api";

/**
 * Startup flow (spec §10): health loading → missing-key instructions →
 * invalid-key error → ready. Every non-ready phase re-checks every 2s —
 * a network failure (server not up yet in dev) keeps the checking card up,
 * and the missing/invalid cards flip straight into the app once the user
 * adds a key and restarts the server, with no manual browser reload.
 */
type Startup =
  | { phase: "checking" }
  | { phase: "missing" }
  | { phase: "invalid"; errorBody?: unknown }
  | { phase: "ready" };

const RETRY_MS = 2000;

export function App() {
  const [startup, setStartup] = useState<Startup>({ phase: "checking" });

  useEffect(() => {
    if (startup.phase === "ready") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async (): Promise<void> => {
      try {
        const health = await getHealth();
        if (cancelled) return;
        if (health.key === "ok") {
          setStartup({ phase: "ready" });
          return;
        }
        setStartup(
          health.key === "missing"
            ? { phase: "missing" }
            : health.error_body === undefined
              ? { phase: "invalid" }
              : { phase: "invalid", errorBody: health.error_body },
        );
      } catch {
        // Server not reachable yet — stay in the current phase.
      }
      if (!cancelled) timer = setTimeout(() => void check(), RETRY_MS);
    };

    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [startup.phase]);

  switch (startup.phase) {
    case "ready":
      return <Dashboard />;
    case "checking":
      return <StartupState state="checking" />;
    case "missing":
      return <StartupState state="missing" />;
    case "invalid":
      return startup.errorBody === undefined ? (
        <StartupState state="invalid" />
      ) : (
        <StartupState state="invalid" errorBody={startup.errorBody} />
      );
  }
}
