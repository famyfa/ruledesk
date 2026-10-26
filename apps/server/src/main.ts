import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";

// Load .env if present; in development fall back to .env.development (mock firewall).
for (const file of [".env", process.env.NODE_ENV === "production" ? null : ".env.development"]) {
  if (file && existsSync(resolve(file))) {
    process.loadEnvFile(resolve(file));
    break;
  }
}

try {
  const config = loadConfig();
  const app = await buildApp({ config });
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    app.log.warn(`Listening on ${config.host}. Make sure RuleDeck is not reachable from untrusted networks.`);
  }
  app.log.info(`Topology: ${config.topology.sites.map((s) => s.name).join(", ")}${config.allowWrites ? "" : " (writes disabled)"}`);
  await app.listen({ host: config.host, port: config.port });
  // docker stop / Ctrl+C: close cleanly, which ends every session and logs out of the firewalls.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      app.log.info(`${sig}: signing out of all firewalls and stopping.`);
      void app.close().finally(() => process.exit(0));
    });
  }
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`RuleDeck configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
