import { loadConfig } from "./config.js";
import { createHttpServer } from "./http/server.js";
import { installGracefulShutdown } from "./http/shutdown.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  // QA/dev escape hatch (Wave 4): MOCK_MODE=1 serves the scripted mock client
  // instead of the live sandbox — same wiring as createHttpServer({ mockMode }).
  const mockMode = /^(1|true)$/i.test(process.env["MOCK_MODE"] ?? "");
  const app = await createHttpServer({
    config,
    ...(mockMode ? { mockMode: true } : {}),
  });
  await app.listen({ port: config.port, host: "127.0.0.1" });
  // Drain connections on Ctrl-C / SIGTERM instead of dropping them (P2-R.2).
  installGracefulShutdown(app);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
