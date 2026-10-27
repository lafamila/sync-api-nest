import { expect, test, type BrowserContext, type Page } from "@playwright/test";

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

async function selectedLocalCandidateType(page: Page, expression: string): Promise<string | null> {
  return page.evaluate(async (peerExpression) => {
    const peer = peerExpression === "host"
      ? (window as unknown as { __peer?: RTCPeerConnection }).__peer
      : (window as unknown as { __syncTestPeers?: RTCPeerConnection[] }).__syncTestPeers?.[0];
    if (!peer) return null;
    const stats = await peer.getStats();
    let pair: RTCStats | undefined;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
      }
    });
    if (!pair) {
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) pair = report;
      });
    }
    if (!pair) return null;
    const candidate = stats.get(pair.localCandidateId);
    return candidate?.candidateType ?? null;
  }, expression);
}

test("forces TURN relay for video and input roundtrip", async ({ browser, context, page }) => {
  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    Object.defineProperty(window, "__syncTestPeers", { value: peers });
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(Target, args: ConstructorParameters<typeof RTCPeerConnection>) {
        const config = args[0] ?? {};
        const peer = new Target({ ...config, iceTransportPolicy: "relay" });
        peers.push(peer);
        return peer;
      },
    });
  });

  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/__test/host");
  await expect.poll(() => host.evaluate(() => Boolean((window as unknown as { __hostReady: boolean }).__hostReady))).toBe(true);

  await authorize(context);
  await page.goto("/");
  await page.getByRole("button", { name: /Studio Mac/ }).click();
  await page.getByLabel("6-digit access code").fill("123456");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await expect.poll(() => selectedLocalCandidateType(page, "controller")).toBe("relay");
  await expect.poll(() => selectedLocalCandidateType(host, "host")).toBe("relay");
  await expect.poll(() => host.evaluate(() => {
    const messages = (window as unknown as { __messages: Array<{ type: string }> }).__messages;
    return messages.some((message) => message.type === "heartbeat");
  })).toBe(true);

  const stage = page.getByTestId("video-stage");
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  await expect.poll(() => host.evaluate(() => {
    const messages = (window as unknown as { __messages: Array<{ type: string; button?: string }> }).__messages;
    return messages.some((message) => message.type === "button" && message.button === "left");
  })).toBe(true);

  await hostContext.close();
});
