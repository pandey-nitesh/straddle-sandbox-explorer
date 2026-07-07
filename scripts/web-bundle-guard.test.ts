import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Redactor web-bundle-unreachability guard (spec §8/§12).
 *
 * The redactor lives in server/src/redaction.ts and must be UNREACHABLE from
 * the web bundle — if the browser needed a redactor, secrets would already
 * have crossed the wire. Two independent checks:
 *
 * 1. Build web/dist and assert that distinctive string/regex literals from
 *    redaction.ts appear in NO dist asset (literals survive minification even
 *    though identifiers do not).
 * 2. Scan web/src import specifiers and assert nothing imports server/ code
 *    (by path or by package name).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "web", "dist");
const REDACTION_SOURCE = path.join(ROOT, "server", "src", "redaction.ts");

/**
 * Literals lifted from redaction.ts. Each must exist in the redaction source
 * (asserted below, so a redaction.ts refactor cannot silently make this guard
 * vacuous) and in no built asset.
 */
const REDACTION_MARKERS = [
  "[redacted]", // the MASK constant (quote-style-agnostic)
  "sk_[A-Za-z0-9_-]{4,}", // SK_TOKEN_PATTERN source
  "[0-9a-f]{8}\\.\\d{2}\\.[0-9a-f]{64}", // PAYKEY_TOKEN_PATTERN source
  "auth|key|token|secret|cookie|session", // KEY_LIKE_HEADER_PATTERN source
] as const;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

beforeAll(() => {
  // Always build fresh — a stale dist would make the scan meaningless.
  execSync("npm run build -w @sse/web", { cwd: ROOT, stdio: "pipe" });
});

describe("web bundle redactor-unreachability guard", () => {
  it("markers are real (present in server/src/redaction.ts)", () => {
    const source = readFileSync(REDACTION_SOURCE, "utf8");
    for (const marker of REDACTION_MARKERS) {
      expect(source, `marker no longer in redaction.ts: ${marker}`).toContain(
        marker,
      );
    }
  });

  it("no dist asset contains any redaction marker", () => {
    expect(existsSync(DIST)).toBe(true);
    const assets = [...walk(DIST)];
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      // latin1 keeps byte-for-byte content so binary assets scan too.
      const contents = readFileSync(asset, "latin1");
      for (const marker of REDACTION_MARKERS) {
        expect(
          contents.includes(marker),
          `${path.relative(ROOT, asset)} contains redaction marker ${marker}`,
        ).toBe(false);
      }
      expect(
        contents.includes("createRedactor"),
        `${path.relative(ROOT, asset)} references createRedactor`,
      ).toBe(false);
    }
  });

  it("no web/src module imports from server/", () => {
    const webSrc = path.join(ROOT, "web", "src");
    const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
    for (const file of walk(webSrc)) {
      if (!/\.(ts|tsx|css)$/.test(file)) continue;
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        const resolvesIntoServer =
          specifier.startsWith("@sse/server") ||
          /(^|\/)server\//.test(specifier) ||
          (specifier.startsWith(".") &&
            path
              .resolve(path.dirname(file), specifier)
              .startsWith(path.join(ROOT, "server")));
        expect(
          resolvesIntoServer,
          `${path.relative(ROOT, file)} imports server code: ${specifier}`,
        ).toBe(false);
      }
    }
  });
});
