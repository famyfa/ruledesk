import { defineConfig } from "@playwright/test";

/**
 * E2E tests run against the dev stack with two MOCK firewalls. The environment
 * is pinned here, so a lab or production config in apps/server/.env is never used.
 */
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1600, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    // Never attach to an already running stack: it might point at real firewalls.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      RULEDECK_TOPOLOGY_FILE: "./topology.dev.json",
      RULEDECK_ALLOW_WRITES: "true",
      RULEDECK_APPLY_RATE_LIMIT: "200",
      RULEDECK_SITE_LOGIN_FAILURES: "100",
      NODE_ENV: "development",
      MOCK_AUTOLOG: "0", // tests control the log themselves
    },
  },
});
