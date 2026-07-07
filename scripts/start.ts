/**
 * `npm start` (spec §4): build web/dist if absent, then run the server, which
 * serves the JSON API and the static bundle single-origin on :8787
 * (PORT overridable via env).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const bin = (name: string): string =>
  path.join(root, "node_modules", ".bin", name);

if (!existsSync(path.join(root, "web", "dist", "index.html"))) {
  console.log("[start] web/dist missing — building the web bundle");
  const build = spawnSync(bin("vite"), ["build"], {
    cwd: path.join(root, "web"),
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error("[start] web build failed");
    process.exit(build.status ?? 1);
  }
}

const server = spawn(bin("tsx"), ["server/src/index.ts"], {
  cwd: root,
  stdio: "inherit",
});
server.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill("SIGTERM"));
}
