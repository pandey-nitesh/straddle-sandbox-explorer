/**
 * `npm run dev` (spec §4): tsx-watch server on :8787 plus Vite on :5173 with
 * a /api proxy to 8787 (web/vite.config.ts). A tiny spawner instead of a
 * `concurrently` dependency — recorded decision; nothing else needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const bin = (name: string): string =>
  path.join(root, "node_modules", ".bin", name);

const children: ChildProcess[] = [];
let shuttingDown = false;

function launch(label: string, command: string, args: string[], cwd: string) {
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[dev] ${label} exited (${code ?? "signal"}); stopping`);
    for (const other of children) other.kill("SIGTERM");
    process.exitCode = code ?? 1;
  });
  children.push(child);
}

launch("server", bin("tsx"), ["watch", "server/src/index.ts"], root);
launch("web", bin("vite"), [], path.join(root, "web"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const child of children) child.kill("SIGTERM");
  });
}
