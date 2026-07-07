import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { StartupState } from "./components/StartupState";
import { fetchHealth } from "./health";

/**
 * Startup flow (spec §10): health loading → missing-key instructions →
 * invalid-key error → ready. A network failure (server not up yet in dev)
 * keeps the checking card up and retries every 2s.
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async (): Promise<void> => {
      try {
        const health = await fetchHealth();
        if (cancelled) return;
        if (health.key === "ok") {
          setStartup({ phase: "ready" });
        } else if (health.key === "missing") {
          setStartup({ phase: "missing" });
        } else {
          setStartup(
            health.error_body === undefined
              ? { phase: "invalid" }
              : { phase: "invalid", errorBody: health.error_body },
          );
        }
      } catch {
        if (!cancelled) timer = setTimeout(() => void check(), RETRY_MS);
      }
    };

    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

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
