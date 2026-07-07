import { useEffect, useState } from "react";

/**
 * Wall-clock tick for live elapsed timers (running scenario rows §6.1, the
 * in-flight bottom timeline node §6.2). Ticks only while `active` — an idle
 * screen schedules no timers.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
