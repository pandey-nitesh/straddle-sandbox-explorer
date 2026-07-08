import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "./shutdown.js";

describe("createShutdownHandler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains then exits 0 on a clean close", async () => {
    let resolveClose: () => void = () => {};
    const close = vi.fn(
      () => new Promise<void>((resolve) => (resolveClose = resolve)),
    );
    const exit = vi.fn();
    const handler = createShutdownHandler({ close, exit });

    handler("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    resolveClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second signal during shutdown is ignored", () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const handler = createShutdownHandler({ close, exit });

    handler("SIGINT");
    handler("SIGINT");
    handler("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when the drain rejects", async () => {
    const close = vi.fn(() => Promise.reject(new Error("boom")));
    const exit = vi.fn();
    const handler = createShutdownHandler({ close, exit });

    handler("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("force-exits 1 when the drain hangs past the timeout", () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    const handler = createShutdownHandler({ close, exit, timeoutMs: 5_000 });

    handler("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
