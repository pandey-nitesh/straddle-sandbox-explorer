import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SEEDED_BANK_CANARY_VALUES } from "@sse/shared";

const ROOT = process.cwd();
const SCAN_TARGETS = ["report.json", "runs", "web/dist"];
const canaries = [
  process.env["STRADDLE_API_KEY"],
  ...SEEDED_BANK_CANARY_VALUES,
].filter((value): value is string => value !== undefined && value.length > 0);

const failures: string[] = [];

for (const target of SCAN_TARGETS) {
  const abs = path.join(ROOT, target);
  if (!existsSync(abs)) continue;
  for (const file of listFiles(abs)) {
    const contents = readFileSync(file, "utf8");
    for (const canary of canaries) {
      if (contents.includes(canary)) {
        failures.push(`${path.relative(ROOT, file)} contains raw canary ${label(canary)}`);
      }
    }
  }
}

assertIgnored("spike/");
assertIgnored("runs/");
assertUntracked("spike");
assertUntracked("runs");

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("check-secrets: clean");
}

function* listFiles(abs: string): Generator<string> {
  const stat = statSync(abs);
  if (stat.isFile()) {
    yield abs;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(abs)) {
    yield* listFiles(path.join(abs, entry));
  }
}

function assertIgnored(target: string): void {
  const result = spawnSync("git", ["check-ignore", target], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) failures.push(`${target} is not ignored by git`);
}

function assertUntracked(target: string): void {
  const result = spawnSync("git", ["ls-files", target], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.stdout.trim() !== "") failures.push(`${target} has tracked files`);
}

function label(canary: string): string {
  return canary.length <= 4 ? "[short]" : `${canary.slice(0, 2)}...${canary.slice(-2)}`;
}
