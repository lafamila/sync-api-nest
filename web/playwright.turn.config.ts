import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "turn.spec.ts",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4179",
    channel: "chrome",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "SYNC_TEST_FORCE_TURN=1 node tests/mock-server.mjs",
    url: "http://127.0.0.1:4179/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
