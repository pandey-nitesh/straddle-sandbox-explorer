import { describe, expect, it } from "vitest";
import { resolveResumePoint, sseComment, sseFrame } from "./sse.js";

describe("sseFrame", () => {
  it("formats an event with data and no id", () => {
    expect(sseFrame("epoch", { epoch: "e1" })).toBe(
      'event: epoch\ndata: {"epoch":"e1"}\n\n',
    );
  });

  it("emits an id: line so the browser can resume via Last-Event-ID", () => {
    expect(sseFrame("run-event", { seq: 42 }, 42)).toBe(
      'id: 42\nevent: run-event\ndata: {"seq":42}\n\n',
    );
  });
});

describe("sseComment", () => {
  it("formats a comment line carrying no event", () => {
    expect(sseComment("keep-alive")).toBe(": keep-alive\n\n");
  });
});

describe("resolveResumePoint", () => {
  it("prefers Last-Event-ID over ?since (native reconnect wins)", () => {
    expect(resolveResumePoint("3", "9")).toBe(9);
  });

  it("uses ?since on the first connect (no header)", () => {
    expect(resolveResumePoint("3", undefined)).toBe(3);
  });

  it("falls back to 0 for absent or malformed values", () => {
    expect(resolveResumePoint(undefined, undefined)).toBe(0);
    expect(resolveResumePoint("abc", undefined)).toBe(0);
    expect(resolveResumePoint(undefined, "-1")).toBe(0);
  });
});
