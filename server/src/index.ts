import { loadConfig } from "./config.js";
import { createHttpServer } from "./http/server.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createHttpServer({ config });
  await app.listen({ port: config.port, host: "127.0.0.1" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
