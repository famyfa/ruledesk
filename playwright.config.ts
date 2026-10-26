import { defineConfig } from "@playwright/test";

/**
 * E2E tests run against their own stack with two MOCK firewalls, on their own ports
 * (web 5273, server 3100, mocks 9443/9444), so a dev or lab stack on the usual ports
 * keeps running. The environment is pinned here, so apps/server/.env is never used.
 */
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5273",
    viewport: { width: 1600, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5273",
    // Never attach to an already running stack: it might point at real firewalls.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      RULEDECK_TOPOLOGY_FILE: "./topology.e2e.json",
      RULEDECK_PORT: "3100",
      RULEDECK_WEB_PORT: "5273",
      RULEDECK_API_URL: "http://127.0.0.1:3100",
      MOCK_PORT: "9443",
      MOCK_PORT_2: "9444",
      RULEDECK_ALLOW_WRITES: "true",
      RULEDECK_APPLY_RATE_LIMIT: "200",
      RULEDECK_SITE_LOGIN_FAILURES: "100",
      NODE_ENV: "development",
      MOCK_AUTOLOG: "0", // tests control the log themselves
    },
  },
});
