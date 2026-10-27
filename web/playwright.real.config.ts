import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "real-api.spec.ts",
  outputDir: "test-results-real",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  use: {
    baseURL: process.env.SYNC_REAL_WEB_URL ?? "http://127.0.0.1:5179",
    channel: "chrome",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
