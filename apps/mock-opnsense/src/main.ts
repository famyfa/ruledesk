import { buildMockServer } from "./server.ts";

const port = Number(process.env.MOCK_PORT ?? 8443);
const host = process.env.MOCK_HOST ?? "127.0.0.1";

const { app } = buildMockServer({
  version: process.env.MOCK_VERSION,
  apiKey: process.env.MOCK_API_KEY,
  apiSecret: process.env.MOCK_API_SECRET,
  logger: process.env.MOCK_LOG === "1",
});

await app.listen({ port, host });
console.log(`Mock OPNsense listening on http://${host}:${port} (key: mock-key / secret: mock-secret)`);
