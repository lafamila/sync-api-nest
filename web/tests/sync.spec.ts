import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface HarnessState {
  connectCount: number;
  activeSessionId: string | null;
  endedSessionIds: string[];
}

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

async function authorize(context: BrowserContext) {
  await context.addCookies([
    {
      name: "sync_test_auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "sync_csrf",
      value: "csrf-test",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      sameSite: "Strict",
    },
  ]);
}

async function openConnect(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Online Macs" })).toBeVisible();
  await expect(page.getByText("Offline Mac")).toHaveCount(0);
  await expect(page.getByText("Test iPhone")).toHaveCount(0);
  await page.getByRole("button", { name: /Studio Mac/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function harnessState(page: Page): Promise<HarnessState> {
  return page.request.get("/__test/state").then((response) => response.json() as Promise<HarnessState>);
}

async function connectController(page: Page) {
  await openConnect(page);
  await page.getByLabel("6-digit access code").fill("123456");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
}

test("keeps devices and controls behind the server session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Online Macs" })).toHaveCount(0);
  await expect(page.getByTestId("video-stage")).toHaveCount(0);
});

test("shows only owned online Macs and enforces a six-digit code", async ({ context, page }) => {
  await authorize(context);
  await openConnect(page);
  const code = page.getByLabel("6-digit access code");
  await code.fill("12345");
  await expect(page.getByRole("button", { name: "Connect" })).toBeDisabled();
  await code.fill("000000");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid access code");
});

test("keeps the device flow within a mobile viewport", async ({ context, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authorize(context);
  await openConnect(page);
  await page.getByLabel("6-digit access code").fill("123456");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-connect.png"), fullPage: true });
});

test("negotiates real WebRTC video and both control channels", async ({ browser, context, page }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/__test/host");
  await expect.poll(() => host.evaluate(() => Boolean((window as unknown as { __hostReady: boolean }).__hostReady))).toBe(true);

  await authorize(context);
  await openConnect(page);
  await page.getByLabel("6-digit access code").fill("123456");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("remote-console.png"), fullPage: true });

  await expect.poll(() => host.evaluate(() => (window as unknown as { __channels: unknown[] }).__channels)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: "sync-control", ordered: true, maxRetransmits: null }),
      expect.objectContaining({ label: "sync-motion", ordered: false, maxRetransmits: 0 }),
    ]),
  );

  const stage = page.getByTestId("video-stage");
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 42);
  await page.getByRole("button", { name: "Keyboard" }).click();
  const textInput = page.getByLabel("Remote text input");
  await textInput.fill("Sync 한글");
  await page.getByRole("button", { name: "Command" }).click();
  await textInput.press("a");
  await page.getByRole("button", { name: "Command" }).click();

  const cdp = await context.newCDPSession(page);
  const touchStart = async (points: Array<{ id: number; x: number; y: number }>) =>
    cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
  const touchMove = async (points: Array<{ id: number; x: number; y: number }>) =>
    cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points });
  const touchEnd = async () =>
    cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;

  await touchStart([{ id: 1, x: centerX - 18, y: centerY }, { id: 2, x: centerX + 18, y: centerY }]);
  await touchEnd();
  await touchStart([{ id: 3, x: centerX - 18, y: centerY }, { id: 4, x: centerX + 18, y: centerY }]);
  await touchMove([{ id: 3, x: centerX - 18, y: centerY + 32 }, { id: 4, x: centerX + 18, y: centerY + 32 }]);
  await touchEnd();
  await touchStart([{ id: 5, x: centerX - 18, y: centerY }, { id: 6, x: centerX + 18, y: centerY }]);
  await touchMove([{ id: 5, x: centerX - 52, y: centerY }, { id: 6, x: centerX + 52, y: centerY }]);
  await touchEnd();
  const beforeDrag = await host.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages.length);
  await touchStart([{ id: 7, x: centerX, y: centerY }]);
  await touchMove([{ id: 7, x: centerX + 36, y: centerY + 12 }]);
  await touchMove([{ id: 7, x: centerX + 72, y: centerY + 24 }]);
  await touchEnd();

  await expect(page.getByTestId("remote-video")).not.toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

  await expect.poll(() => host.evaluate(() => (window as unknown as { __messages: Array<{ type: string }> }).__messages.map((message) => message.type))).toEqual(
    expect.arrayContaining(["heartbeat", "button", "scroll", "text", "key"]),
  );
  await expect.poll(() => host.evaluate(() => (window as unknown as { __messages: Array<{ type: string; button?: string }> }).__messages.some((message) => message.type === "button" && message.button === "right"))).toBe(true);
  await expect.poll(() => host.evaluate((offset) => {
    const messages = (window as unknown as { __messages: Array<{ type: string; button?: string; down?: boolean }> }).__messages.slice(offset);
    return messages.some((message) => message.type === "button" && message.button === "left" && message.down === true)
      && messages.some((message) => message.type === "pointer")
      && messages.some((message) => message.type === "button" && message.button === "left" && message.down === false);
  }, beforeDrag)).toBe(true);
  await expect.poll(async () => Number(await page.getByTestId("data-rx").textContent())).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(() => host.evaluate(() => (window as unknown as { __messages: Array<{ type: string }> }).__messages.some((message) => message.type === "release-all"))).toBe(true);

  const messages = await host.evaluate(() => (window as unknown as { __messages: Array<{ epoch: string; seq: number }> }).__messages);
  expect(messages.every((message) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.epoch) && Number.isInteger(message.seq))).toBe(true);

  await page.request.post("/__test/end");
  await expect(page.getByRole("alert")).toContainText("Mode disabled");
  await expect(page.getByTestId("video-stage")).toHaveCount(0);
  await hostContext.close();
});

test("reconnects with a fresh peer and never replays old reliable input", async ({ browser, context, page }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/__test/host");
  await expect.poll(() => host.evaluate(() => Boolean((window as unknown as { __hostReady: boolean }).__hostReady))).toBe(true);

  await authorize(context);
  await connectController(page);
  const initial = await harnessState(page);
  expect(initial.connectCount).toBe(1);
  expect(initial.activeSessionId).toBeTruthy();

  await page.getByRole("button", { name: "Keyboard" }).click();
  await page.getByLabel("Remote text input").fill("before-loss-marker");
  await expect.poll(() => host.evaluate(() => {
    const messages = (window as unknown as { __messages: Array<{ type: string; text?: string; __generation: number }> }).__messages;
    return messages.some((message) => message.__generation === 1 && message.type === "text" && message.text === "before-loss-marker");
  })).toBe(true);

  await page.request.post("/__test/drop-controller");
  await expect.poll(async () => (await harnessState(page)).connectCount).toBe(2);
  await expect.poll(() => host.evaluate(() => (window as unknown as { __peerGeneration: number }).__peerGeneration)).toBe(2);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);

  const recovered = await harnessState(page);
  expect(recovered.activeSessionId).not.toBe(initial.activeSessionId);
  expect(recovered.endedSessionIds).toContain(initial.activeSessionId);
  await expect.poll(() => host.evaluate(() =>
    (window as unknown as { __messages: Array<{ seq: number; __generation: number }> }).__messages
      .filter((message) => message.__generation === 2)
      .map((message) => message.seq),
  )).toContain(1);
  const recoveredMessages = await host.evaluate(() =>
    (window as unknown as { __messages: Array<{ type: string; text?: string; seq: number; __generation: number }> }).__messages
      .filter((message) => message.__generation === 2),
  );
  expect(recoveredMessages.some((message) => message.type === "text" && message.text === "before-loss-marker")).toBe(false);
  expect(Math.min(...recoveredMessages.map((message) => message.seq))).toBe(1);

  const textInput = page.getByLabel("Remote text input");
  if (!await textInput.isVisible()) await page.getByRole("button", { name: "Keyboard" }).click();
  await textInput.fill("after-reconnect-marker");
  await expect.poll(() => host.evaluate(() => {
    const messages = (window as unknown as { __messages: Array<{ type: string; text?: string; __generation: number }> }).__messages;
    return messages.some((message) => message.__generation === 2 && message.type === "text" && message.text === "after-reconnect-marker");
  })).toBe(true);

  const beforeModeOff = (await harnessState(page)).connectCount;
  await page.request.post("/__test/mode-off");
  await expect(page.getByRole("alert")).toContainText("Mode disabled");
  await expect(page.getByTestId("video-stage")).toHaveCount(0);
  await page.waitForTimeout(2_200);
  expect((await harnessState(page)).connectCount).toBe(beforeModeOff);
  await hostContext.close();
});

test("renews the session after a foregrounded heartbeat lease expires", async ({ browser, context, page }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/__test/host");
  await expect.poll(() => host.evaluate(() => Boolean((window as unknown as { __hostReady: boolean }).__hostReady))).toBe(true);

  await authorize(context);
  await connectController(page);
  await page.evaluate(() => {
    const state = window as unknown as { __syncVisibility: DocumentVisibilityState };
    state.__syncVisibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state.__syncVisibility,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1_650);
  await page.evaluate(() => {
    const state = window as unknown as { __syncVisibility: DocumentVisibilityState };
    state.__syncVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(async () => (await harnessState(page)).connectCount).toBe(2);
  await expect.poll(() => host.evaluate(() => (window as unknown as { __peerGeneration: number }).__peerGeneration)).toBe(2);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await hostContext.close();
});

test("does not retry a reconnect rejected with 403", async ({ browser, context, page }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/__test/host");
  await expect.poll(() => host.evaluate(() => Boolean((window as unknown as { __hostReady: boolean }).__hostReady))).toBe(true);

  await authorize(context);
  await connectController(page);
  await page.request.post("/__test/reject-next-connect");
  await page.request.post("/__test/drop-controller");
  await expect.poll(async () => (await harnessState(page)).connectCount).toBe(2);
  await expect(page.getByRole("alert")).toContainText("Invalid access code");
  await expect(page.getByTestId("video-stage")).toHaveCount(0);
  await page.waitForTimeout(2_200);
  expect((await harnessState(page)).connectCount).toBe(2);
  await hostContext.close();
});
