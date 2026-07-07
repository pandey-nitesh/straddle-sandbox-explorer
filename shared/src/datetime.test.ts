import { describe, expect, it } from "vitest";
import { LenientDatetimeSchema } from "./datetime.js";

describe("LenientDatetimeSchema (api-notes §12 item 15)", () => {
  // The two live-observed formats, verbatim from api-notes.md §4:
  it("accepts 7-digit fractional seconds + Z (api_request_timestamp / POST created_at)", () => {
    expect(
      LenientDatetimeSchema.safeParse("2026-07-07T06:21:43.8306543Z").success,
    ).toBe(true);
  });

  it("accepts second precision with no fraction and NO timezone suffix (GET customer/review)", () => {
    expect(
      LenientDatetimeSchema.safeParse("2026-07-07T06:21:44").success,
    ).toBe(true);
  });

  it("accepts common ISO forms (millis + Z, offset, no-fraction + Z)", () => {
    for (const s of [
      "2026-07-07T06:21:43.830Z",
      "2026-07-07T06:21:43Z",
      "2026-07-07T06:21:43+02:00",
      "2026-07-07T06:21:43.123456789-05:30",
      "2026-12-31T23:59:59.1Z",
    ]) {
      expect(LenientDatetimeSchema.safeParse(s).success, s).toBe(true);
    }
  });

  it("rejects non-datetime strings", () => {
    for (const s of [
      "",
      "not a date",
      "2026-07-07", // date only
      "06:21:44", // time only
      "2026-07-07 06:21:44", // space separator
      "2026-13-07T06:21:44", // month 13
      "2026-07-32T06:21:44", // day 32
      "2026-07-07T24:00:00", // hour 24
      "2026-07-07T06:61:44", // minute 61
      "2026-07-07T06:21:43.Z", // dot with no digits
      "2026-07-07T06:21:43.1234567890Z", // 10 fractional digits
      "2026-07-07T06:21:43ZZ",
      "2026-07-07T06:21:43+0200", // offset without colon
    ]) {
      expect(LenientDatetimeSchema.safeParse(s).success, s).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(LenientDatetimeSchema.safeParse(1751869303000).success).toBe(false);
    expect(LenientDatetimeSchema.safeParse(new Date()).success).toBe(false);
  });
});
