import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const SESSION_COOKIE = process.env.SYNC_REAL_SESSION_COOKIE;
const CSRF_COOKIE = process.env.SYNC_REAL_CSRF_COOKIE;
const WEB_URL = process.env.SYNC_REAL_WEB_URL ?? "http://127.0.0.1:5179";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.beforeAll(async () => {
  await mkdir("artifacts", { recursive: true });
});

test("uses the real ready API and preserves the unauthenticated boundary", async ({ context, page }) => {
  const healthResponse = await page.request.get("/api/health");
  expect(healthResponse.status()).toBe(200);
  const health = await healthResponse.json() as {
    status: string;
    ready: boolean;
    product: string;
    dependencies: { database: string; redis: string };
  };
  expect(health).toMatchObject({
    status: "ok",
    ready: true,
    product: "Sync",
    dependencies: { database: "up", redis: "up" },
  });

  const configResponse = await page.request.get("/api/config");
  expect(configResponse.status()).toBe(200);
  const config = await configResponse.json() as {
    product: string;
    version: string;
    authConfigured: boolean;
    webUrl: string;
  };
  expect(config).toMatchObject({
    product: "Sync",
    version: "0.1.0",
    authConfigured: expect.any(Boolean),
    webUrl: expect.any(String),
  });

  const meResponse = await page.request.get("/api/session/me");
  expect(meResponse.status()).toBe(401);
  const devicesResponse = await page.request.get("/api/devices");
  expect(devicesResponse.status()).toBe(401);
  expect(await context.cookies()).toEqual([]);

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByTestId("video-stage")).toHaveCount(0);
  const desktopScreenshot = await page.screenshot({ fullPage: true });
  await writeFile("artifacts/real-api-desktop.png", desktopScreenshot);
  await test.info().attach("desktop-guest", { body: desktopScreenshot, contentType: "image/png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const mobileScreenshot = await page.screenshot({ fullPage: true });
  await writeFile("artifacts/real-api-mobile.png", mobileScreenshot);
  await test.info().attach("mobile-guest", { body: mobileScreenshot, contentType: "image/png" });

  if (!config.authConfigured) {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Central authentication is not configured");
    return;
  }

  let start: { authorizeUrl: string; transactionId: string } | null = null;
  let startStatus: number | null = null;
  await page.route("**/api/session/oidc/start", async (route) => {
    const response = await route.fetch();
    startStatus = response.status();
    start = await response.json() as { authorizeUrl: string; transactionId: string };
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(() => start).not.toBeNull();
  expect(startStatus).toBeGreaterThanOrEqual(200);
  expect(startStatus).toBeLessThan(300);
  const observedStart = start!;
  const authorizeUrl = new URL(observedStart.authorizeUrl);
  const callbackUrl = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
  expect(authorizeUrl.origin).not.toBe(new URL(WEB_URL).origin);
  expect(authorizeUrl.pathname).toBe("/oauth/authorize");
  expect(authorizeUrl.searchParams.get("client_id")).toBe("sync-api");
  expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
  expect(authorizeUrl.searchParams.get("scope")).toBe("openid profile email service.permission");
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(observedStart.transactionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callbackUrl.origin).toBe(new URL(config.webUrl).origin);
  expect(callbackUrl.pathname).toBe("/api/session/oidc/callback");
  expect(authorizeUrl.searchParams.has("token")).toBe(false);
  expect(authorizeUrl.searchParams.has("session")).toBe(false);
  await page.waitForURL((url) => url.origin === authorizeUrl.origin && url.pathname === authorizeUrl.pathname);
});

test("reads UUID epochs from an authenticated real API session", async ({ context, page }) => {
  test.skip(!SESSION_COOKIE || !CSRF_COOKIE, "Set real session and CSRF cookies to verify authenticated wire epochs");
  await context.addCookies([
    { name: "sync_session", value: SESSION_COOKIE!, url: WEB_URL, httpOnly: true, sameSite: "Lax" },
    { name: "sync_csrf", value: CSRF_COOKIE!, url: WEB_URL, httpOnly: false, sameSite: "Strict" },
  ]);

  const [devicesResponse, sessionsResponse] = await Promise.all([
    page.request.get("/api/devices"),
    page.request.get("/api/sessions"),
  ]);
  expect(devicesResponse.status()).toBe(200);
  expect(sessionsResponse.status()).toBe(200);

  const devices = (await devicesResponse.json() as {
    devices: Array<{ mode: { epoch: unknown } | null }>;
  }).devices;
  const sessions = (await sessionsResponse.json() as {
    sessions: Array<{ epoch: unknown }>;
  }).sessions;
  const epochs = [
    ...devices.flatMap((device) => device.mode ? [device.mode.epoch] : []),
    ...sessions.map((session) => session.epoch),
  ];
  test.skip(epochs.length === 0, "The authenticated account has no mode or session epoch to inspect");
  for (const epoch of epochs) {
    expect(typeof epoch).toBe("string");
    expect(String(epoch)).toMatch(UUID);
  }
});
