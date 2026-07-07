/**
 * Wave 4 QA screenshot driver (design §11 Playwright visual checks).
 *
 * Boots real createHttpServer instances (mock mode + both startup states),
 * serves the built web/dist, and drives a real Chromium via Playwright.
 * Screenshots land in web/qa-screenshots/ (gitignored).
 *
 * Time scaling: the mock client's schedules replay the MEASURED sandbox
 * timings (C's reversal at +358 s), so the mock server gets a scaled clock —
 * time runs SCALE× faster than wall clock, while the browser still polls in
 * real time. Nothing in server/ changes; the clock is injected through the
 * existing createHttpServer({ clock }) seam.
 *
 * Run: NODE_USE_ENV_PROXY=1 npx tsx scripts/qa-screenshots.ts
 * (the proxy flag is only needed for the live invalid-key 401 capture).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { loadConfig } from "../server/src/config.js";
import { createHttpServer } from "../server/src/http/server.js";
import type { Clock } from "../server/src/straddle/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "web", "qa-screenshots");
const CHROMIUM_FALLBACK = "/opt/pw-browsers/chromium";

const MOCK_PORT = 8901;
const MISSING_PORT = 8902;
const INVALID_PORT = 8903;

/** Mock schedules replay measured sandbox timings; 30× keeps C under ~15 s. */
const SCALE = 30;

function createScaledClock(scale: number): Clock {
  const base = Date.now();
  return {
    now: () => base + (Date.now() - base) * scale,
    sleep: (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, Math.max(1, ms / scale))),
  };
}

async function startServers() {
  // Mock-mode server: the QA stage. Recorder off — no synthetic runs/ files.
  const mock = await createHttpServer({
    config: loadConfig({ env: { PORT: String(MOCK_PORT) }, envFilePath: false }),
    mockMode: true,
    clock: createScaledClock(SCALE),
    attachRecorder: false,
    logger: false,
  });
  await mock.listen({ port: MOCK_PORT, host: "127.0.0.1" });

  // Missing-key startup state: a config with no key at all.
  const missing = await createHttpServer({
    config: loadConfig({ env: {}, envFilePath: false }),
    attachRecorder: false,
    logger: false,
  });
  await missing.listen({ port: MISSING_PORT, host: "127.0.0.1" });

  // Invalid-key startup state: a syntactically plausible but bogus key; the
  // health check hits the live sandbox once and gets the documented empty 401.
  const invalid = await createHttpServer({
    config: loadConfig({
      env: { STRADDLE_API_KEY: "sk_sandbox_qa_invalid_key_000000" },
      envFilePath: false,
    }),
    attachRecorder: false,
    logger: false,
  });
  await invalid.listen({ port: INVALID_PORT, host: "127.0.0.1" });

  return { mock, missing, invalid };
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ executablePath: CHROMIUM_FALLBACK });
  }
}

async function shoot(page: Page, name: string) {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`captured ${path.relative(ROOT, file)}`);
}

async function main() {
  if (!existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
    console.log("building web/dist…");
    execSync("npm run build -w @sse/web", { cwd: ROOT, stdio: "inherit" });
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const servers = await startServers();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ---- (a) ready state, before any run --------------------------------
    await page.goto(`http://127.0.0.1:${MOCK_PORT}/`);
    await page.getByRole("button", { name: "Run all" }).waitFor({ timeout: 15_000 });
    await page.getByText("Happy path").waitFor();
    await shoot(page, "a-ready.png");

    // ---- kick off the suite ---------------------------------------------
    await page.getByRole("button", { name: "Run all" }).click();

    // ---- (b) mid-run timeline (C selected by default; first observations) -
    await page
      .getByRole("region", { name: "Lifecycle" })
      .getByText("created", { exact: true })
      .waitFor({ timeout: 20_000 });
    await shoot(page, "b-mid-run.png");

    // ---- (c) provisional paid, mid-pulse ---------------------------------
    await page
      .getByText("paid — provisional")
      .waitFor({ timeout: 60_000 });
    await page.getByText("watching for reversal…").waitFor();
    // Land inside the 2s pulse cycle before shooting.
    await page.waitForTimeout(700);
    await shoot(page, "c-provisional-paid.png");

    // ---- (d) C terminal: amber provisional AND red reversed both visible --
    await page
      .getByRole("region", { name: "Lifecycle" })
      .getByText("reversed", { exact: true })
      .waitFor({ timeout: 60_000 });
    await page.getByText("paid — provisional").waitFor(); // amber node STAYS
    await shoot(page, "d-c-terminal-both-nodes.png");

    // ---- (e) Scenario E evidence card -------------------------------------
    await page.getByText("Rejected identity").click();
    await page.getByTestId("evidence-card").waitFor({ timeout: 30_000 });
    await page.getByText("customer status: rejected").waitFor();
    await shoot(page, "e-evidence-card.png");

    // ---- (h) suite summary after full mock Run All ------------------------
    await page.getByText("5/5 passed").waitFor({ timeout: 120_000 });
    // Expand the per-scenario assertion drill-down (§6.5).
    await page.getByText(/5\/5 passed · .* elapsed/).click();
    await page.getByText("C. Reversal").waitFor();
    await shoot(page, "h-suite-summary.png");

    // ---- (f) missing-key startup state ------------------------------------
    await page.goto(`http://127.0.0.1:${MISSING_PORT}/`);
    await page.getByText("Add your sandbox API key").waitFor({ timeout: 15_000 });
    await shoot(page, "f-missing-key.png");

    // ---- (g) invalid-key startup state (one live sandbox 401) -------------
    await page.goto(`http://127.0.0.1:${INVALID_PORT}/`);
    try {
      await page
        .getByText("Straddle rejected this key")
        .waitFor({ timeout: 30_000 });
      await shoot(page, "g-invalid-key.png");
    } catch {
      console.error(
        "invalid-key capture failed (live sandbox unreachable?) — " +
          "run with NODE_USE_ENV_PROXY=1 or check connectivity",
      );
      await shoot(page, "g-invalid-key-FAILED.png");
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await Promise.all([
      servers.mock.close(),
      servers.missing.close(),
      servers.invalid.close(),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
