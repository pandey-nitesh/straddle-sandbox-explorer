import { useCallback, useState } from "react";

/**
 * Global Explain toggle (design §6.6): on = learning notes render everywhere,
 * off = today's demo-clean screen. Persisted so a presenter's choice survives
 * reloads. Default on — the learning layer is the point for first-time users.
 */
const STORAGE_KEY = "sse-explain";

function readInitial(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function useExplain(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(readInitial);
  const toggle = useCallback(() => {
    setEnabled((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
      } catch {
        // Private-mode storage failures just lose persistence, not the toggle.
      }
      return next;
    });
  }, []);
  return [enabled, toggle];
}
