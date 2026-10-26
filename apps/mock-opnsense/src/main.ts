import { buildMockServer } from "./server.ts";

/**
 * Starts the mock firewalls used in development (see apps/server/topology.dev.json).
 * Each instance accepts the users from DEFAULT_USERS (e.g. admin / ruledeck-dev).
 */
const host = process.env.MOCK_HOST ?? "127.0.0.1";
const instances = [
  { name: "Berlin", port: Number(process.env.MOCK_PORT ?? 8443) },
  { name: "Munich", port: Number(process.env.MOCK_PORT_2 ?? 8444) },
];

for (const inst of instances) {
  const opts = { version: process.env.MOCK_VERSION, logger: process.env.MOCK_LOG === "1", autoLog: process.env.MOCK_AUTOLOG !== "0" };
  const { app, linkSecondary } = buildMockServer(opts);
  linkSecondary(buildMockServer({ version: process.env.MOCK_VERSION })); // the HA peer (answers in-process, no port)
  await app.listen({ port: inst.port, host });
  console.log(`Mock OPNsense "${inst.name}" on http://${host}:${inst.port} (sign in as admin / ruledeck-dev)`);
}
