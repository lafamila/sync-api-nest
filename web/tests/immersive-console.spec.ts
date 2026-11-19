import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import {
  openRemoteKeyboard,
  revealConnectionDetails,
  revealKeyboardControls,
  revealSessionControls,
} from "./console-helpers";

interface Message {
  type: string;
  key?: string;
  text?: string;
  down?: boolean;
  modifiers?: string[];
  x?: number;
  y?: number;
}

interface HostState {
  __hostReady: boolean;
  __peerGeneration: number;
  __messages: Message[];
  __acceptedMessages: Message[];
}

type MessageSource = "__messages" | "__acceptedMessages";

const test = base.extend<{ host: Page }>({
  host: async ({ browser }, use) => {
    const context = await browser.newContext();
    try {
      const host = await context.newPage();
      await host.goto("/__test/host");
      await expect.poll(() => host.evaluate(() => (window as unknown as HostState).__hostReady)).toBe(true);
      await use(host);
    } finally {
      await context.close();
    }
  },
});

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

async function connect(context: BrowserContext, page: Page, host: Page, scope = "Control") {
  await context.addCookies([
    { name: "sync_test_auth", value: "1", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
    { name: "sync_csrf", value: "csrf-test", domain: "127.0.0.1", path: "/", sameSite: "Strict" },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: /Studio Mac/ }).click();
  await page.getByRole("button", { name: scope, exact: true }).click();
  await page.getByLabel("6-digit access code").fill("123456");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("remote-console")).toBeVisible();
  await expect.poll(() => page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);
  if (scope === "Control") {
    await expect.poll(() => host.evaluate(() =>
      (window as unknown as HostState).__acceptedMessages.some(message => message.type === "heartbeat"),
    )).toBe(true);
  }
}

async function inputMessages(host: Page, source: MessageSource = "__acceptedMessages") {
  return host.evaluate(source =>
    (window as unknown as HostState)[source].filter(message =>
      ["pointer", "button", "scroll", "key", "text"].includes(message.type),
    ).map(message => {
      const { __generation, __sessionId, ...wire } = message as Message & { __generation?: number; __sessionId?: string };
      return wire;
    }), source);
}

async function expectHiddenCapture(page: Page) {
  const input = page.getByLabel("Remote text input", { exact: true });
  await expect(input).toHaveCount(1);
  expect(await input.boundingBox()).toEqual(expect.objectContaining({ width: 1, height: 1 }));
  await expect.poll(() => input.evaluate(element => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  })).toBe(0);
}

async function expectNoInput(host: Page, page: Page, operation: () => Promise<void>) {
  // Include rejected frames: local UI must not attempt remote input at all.
  const before = await inputMessages(host, "__messages");
  await operation();
  await page.waitForTimeout(200);
  expect(await inputMessages(host, "__messages")).toEqual(before);
}

async function bounds(page: Page) {
  return {
    stage: await page.getByTestId("video-stage").boundingBox(),
    video: await page.getByTestId("remote-video").boundingBox(),
  };
}

async function expectViewport(page: Page) {
  const viewport = page.viewportSize()!;
  await expect.poll(() => page.getByTestId("video-stage").boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  expect(await page.getByTestId("remote-console").boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  expect(await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
    x: scrollX,
    y: scrollY,
  }))).toEqual({
    documentWidth: viewport.width,
    documentHeight: viewport.height,
    bodyWidth: viewport.width,
    bodyHeight: viewport.height,
    x: 0,
    y: 0,
  });
}

async function colorfulVideoPixels(page: Page) {
  return page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 45;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colorful = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      const rgb = [bytes[index], bytes[index + 1], bytes[index + 2]];
      if (Math.max(...rgb) - Math.min(...rgb) > 10 && rgb.reduce((sum, value) => sum + value, 0) > 30) colorful++;
    }
    return colorful;
  });
}

for (const device of [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  { name: "small-desktop", viewport: { width: 800, height: 600 }, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });

    test("starts immersive and keeps overlays out of video layout and peer ownership", async ({ context, page, host }) => {
      await connect(context, page, host);
      await expectViewport(page);
      await expect(page.getByRole("complementary", { name: "Connection metrics", includeHidden: true })).toBeHidden();
      for (const name of ["Show session controls", "Show connection details", "Show keyboard controls"]) {
        await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-expanded", "false");
      }
      await expect(page.getByTestId("remote-video")).toHaveCSS("object-fit", "contain");
      await expect.poll(() => colorfulVideoPixels(page)).toBeGreaterThan(3000);
      const initial = await bounds(page);
      const input = page.getByLabel("Remote text input", { exact: true });
      await expectHiddenCapture(page);
      if (!device.isMobile) await expect(input).toBeFocused();
      const capture = await input.elementHandle();
      const screenshot = await page.screenshot({ path: test.info().outputPath(`${device.name}-immersive.png`) });
      expect(screenshot.byteLength).toBeGreaterThan(5000);

      await revealConnectionDetails(page);
      expect(await bounds(page)).toEqual(initial);
      await page.screenshot({ path: test.info().outputPath(`${device.name}-connection-details.png`) });
      await page.mouse.move(device.viewport.width / 2, device.viewport.height / 2);
      await expect(page.getByRole("complementary", { name: "Connection metrics" })).toBeVisible();
      await page.getByRole("button", { name: "Hide connection details", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Connection metrics", includeHidden: true })).toBeHidden();
      expect(await bounds(page)).toEqual(initial);

      await revealKeyboardControls(page);
      await expect(page.getByRole("button", { name: "Keyboard", exact: true })).toBeVisible();
      await openRemoteKeyboard(page);
      expect(await bounds(page)).toEqual(initial);
      await page.screenshot({ path: test.info().outputPath(`${device.name}-keyboard-open.png`) });
      expect(await capture!.evaluate(element => element.isConnected && element === document.querySelector('textarea[aria-label="Remote text input"]'))).toBe(true);
      await page.getByRole("button", { name: "Keyboard", exact: true }).click();
      await expectHiddenCapture(page);
      expect(await capture!.evaluate(element => element.isConnected)).toBe(true);
      await page.getByRole("button", { name: "Hide keyboard controls", exact: true }).click();
      expect(await bounds(page)).toEqual(initial);

      await revealSessionControls(page);
      await expect(page.getByText("Connected", { exact: true })).toHaveText("Connected");
      if (!device.isMobile) await expect(page.getByText("Connected", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Display", { exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${device.name}-session-controls.png`) });
      await page.getByRole("button", { name: "Hide session controls", exact: true }).click();
      expect(await bounds(page)).toEqual(initial);
      await expectViewport(page);
      expect(await host.evaluate(() => (window as unknown as HostState).__peerGeneration)).toBe(1);
      const state = await page.request.get("/__test/state").then(response => response.json());
      expect(state.connectCount).toBe(1);
      expect(state.endedSessionIds).toEqual([]);
      expect(state.recoveryBodies).toEqual([]);
    });
  });
}

test("captures desktop typing and special-key down/up without opening Keyboard", async ({ context, page, host }) => {
  await connect(context, page, host);
  const input = page.getByLabel("Remote text input", { exact: true });
  await expect(input).toBeFocused();
  await expectHiddenCapture(page);
  await page.keyboard.type("az");
  for (const key of ["Enter", "Tab", "Backspace", "ArrowLeft"]) await page.keyboard.press(key);
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text)).toEqual(["a", "z"]);
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "key").map(({ key, down, modifiers }) => ({ key, down, modifiers }))).toEqual(
    ["Enter", "Tab", "Backspace", "ArrowLeft"].flatMap(key => [
      { key, down: true, modifiers: [] },
      { key, down: false, modifiers: [] },
    ]),
  );
  await expect(input).toBeFocused();
  expect(await inputMessages(host, "__messages")).toEqual(await inputMessages(host));
});

test("sends physical modifiers only on supported key events and preserves Shift text", async ({ context, page, host }) => {
  await connect(context, page, host);
  for (const modifier of ["Meta", "Control", "Alt", "Shift"]) {
    await page.keyboard.down(modifier);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.up(modifier);
  }
  for (const modifier of ["Meta", "Control", "Alt"]) await page.keyboard.press(`${modifier}+a`);
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "key").map(({ key, down, modifiers }) => ({ key, down, modifiers }))).toEqual(
    [
      ...["meta", "ctrl", "alt", "shift"].flatMap(modifier => [
        { key: "ArrowLeft", down: true, modifiers: [modifier] },
        { key: "ArrowLeft", down: false, modifiers: [modifier] },
      ]),
      ...["meta", "ctrl", "alt"].flatMap(modifier => [
        { key: "KeyA", down: true, modifiers: [modifier] },
        { key: "KeyA", down: false, modifiers: [modifier] },
      ]),
    ],
  );
  await page.keyboard.press("Shift+A");
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text)).toEqual(["A"]);
  expect((await inputMessages(host, "__messages")).some(message => /^(Meta|Control|Alt|Shift)(Left|Right)$/.test(message.key ?? ""))).toBe(false);
});

test("combines a sticky Command with physical Control Option and Shift without shortcut text", async ({ context, page, host }) => {
  await connect(context, page, host);
  await revealKeyboardControls(page);
  await page.getByRole("button", { name: "Command", exact: true }).click();
  await expect(page.getByRole("button", { name: "Command", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Remote text input", { exact: true }).focus();
  await page.keyboard.press("Control+Alt+Shift+a");
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "key").map(({ key, down, modifiers }) => ({ key, down, modifiers: [...(modifiers ?? [])].sort() }))).toEqual([
    { key: "KeyA", down: true, modifiers: ["alt", "ctrl", "meta", "shift"] },
    { key: "KeyA", down: false, modifiers: ["alt", "ctrl", "meta", "shift"] },
  ]);
  expect((await inputMessages(host, "__messages")).filter(message => message.type === "text")).toEqual([]);
});

test("commits hidden-capture Korean IME once and keeps the committed grapheme editable", async ({ context, page, host }) => {
  await connect(context, page, host);
  const input = page.getByLabel("Remote text input", { exact: true });
  await expect(input).toBeFocused();
  await expectHiddenCapture(page);
  const cdp = await context.newCDPSession(page);
  try {
    for (const text of ["\u314e", "\ud558", "\ud55c", "\ud55c\u3131", "\ud55c\uadf8", "\ud55c\uae00"]) {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await expect(input).toHaveValue(text);
      expect(await inputMessages(host, "__messages")).toEqual([]);
    }
    await cdp.send("Input.insertText", { text: "\ud55c\uae00" });
    await expect(input).toHaveValue("\ud55c\uae00");
    await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text)).toEqual(["\ud55c\uae00"]);
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("\ud55c");
    await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "key").map(({ key, down }) => ({ key, down }))).toEqual([
      { key: "Backspace", down: true },
      { key: "Backspace", down: false },
    ]);
    expect(await inputMessages(host, "__messages")).toEqual(await inputMessages(host));
  } finally {
    await cdp.detach();
  }
});

test("keeps direct typing and real Korean IME focused after a video click without Keyboard", async ({ context, page, host }) => {
  await connect(context, page, host);
  await page.getByTestId("video-stage").click();
  const input = page.getByLabel("Remote text input", { exact: true });
  await expect(input).toBeFocused();
  await expectHiddenCapture(page);
  await page.keyboard.type("desk ");
  const text = async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text).join("");
  await expect.poll(text).toBe("desk ");
  const cdp = await context.newCDPSession(page);
  try {
    for (const composition of ["\u314e", "\ud558", "\ud55c", "\ud55c\u3131", "\ud55c\uae00"]) {
      await cdp.send("Input.imeSetComposition", { text: composition, selectionStart: composition.length, selectionEnd: composition.length });
      await expect(input).toHaveValue(`desk ${composition}`);
      expect(await text()).toBe("desk ");
    }
    await cdp.send("Input.insertText", { text: "\ud55c\uae00" });
    await expect.poll(text).toBe("desk \ud55c\uae00");
    await page.keyboard.type("!");
    await expect.poll(text).toBe("desk \ud55c\uae00!");
    await expect(input).toBeFocused();
    await expectHiddenCapture(page);
    await expect(page.getByRole("button", { name: "Show keyboard controls", exact: true })).toHaveAttribute("aria-expanded", "false");
    expect((await inputMessages(host, "__messages")).filter(message => message.type === "key")).toEqual([]);
  } finally {
    await cdp.detach();
  }
});

test("bounds only the hidden capture buffer and preserves grapheme edits over RTC", async ({ context, page, host }) => {
  await connect(context, page, host);
  const input = page.getByLabel("Remote text input", { exact: true });
  const family = "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66";
  const value = "a".repeat(4090) + family.repeat(2);
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment);
  await page.keyboard.insertText(value);
  await expect(input).toHaveValue(segments.slice(-256).join(""));
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text).join("")).toBe(value);
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue(segments.slice(-256, -1).join(""));
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "key").map(({ key, down }) => ({ key, down }))).toEqual([
    { key: "Backspace", down: true },
    { key: "Backspace", down: false },
  ]);
  await openRemoteKeyboard(page);
  await input.fill(value);
  await expect(input).toHaveValue(value);
  expect((await inputMessages(host)).filter(message => message.type === "text").every(message => (message.text?.length ?? 0) <= 1024)).toBe(true);
});

test("overlay toggles buttons and native Display select never leak remote input", async ({ context, page, host }) => {
  await connect(context, page, host);
  await revealSessionControls(page);
  const initial = await bounds(page);
  await expectNoInput(host, page, async () => {
    await page.getByRole("button", { name: "Fill screen", exact: true }).click();
    await page.getByRole("button", { name: "Fit screen", exact: true }).click();
    await page.getByLabel("Display", { exact: true }).selectOption("portrait");
    await expect.poll(() => page.getByTestId("remote-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(360);
    await revealConnectionDetails(page);
    await page.getByRole("complementary", { name: "Connection metrics" }).hover();
    await page.mouse.wheel(0, 60);
    await page.getByRole("button", { name: "Hide connection details", exact: true }).click();
    await revealKeyboardControls(page);
    await page.getByRole("button", { name: "Command", exact: true }).click();
    await page.getByRole("button", { name: "Command", exact: true }).click();
    await page.getByRole("button", { name: "Keyboard", exact: true }).click();
    await page.getByRole("button", { name: "Keyboard", exact: true }).click();
    await page.getByRole("button", { name: "Hide keyboard controls", exact: true }).click();
    await revealSessionControls(page);
    await page.getByRole("button", { name: "Hide session controls", exact: true }).click();
  });
  expect(await bounds(page)).toEqual(initial);
  expect(await host.evaluate(() => (window as unknown as HostState).__peerGeneration)).toBe(1);
});

test("console-local forms selects buttons and contenteditable retain their own keyboard input", async ({ context, page, host }) => {
  await connect(context, page, host);
  await page.getByTestId("remote-console").evaluate(console => {
    const form = document.createElement("form");
    form.style.cssText = "position:fixed;z-index:9999;top:80px;left:30px;background:white;color:black";
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Local draft");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Local selection");
    for (const text of ["One", "Two"]) select.add(new Option(text, text));
    const button = document.createElement("button");
    button.textContent = "Save local draft";
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.setAttribute("aria-label", "Local rich text");
    form.addEventListener("submit", event => event.preventDefault());
    form.append(input, select, button, editable);
    console.append(form);
  });
  await expectNoInput(host, page, async () => {
    const draft = page.getByLabel("Local draft", { exact: true });
    await draft.click();
    await page.keyboard.type("local-only");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(draft).toHaveValue("local-onl");
    await page.getByLabel("Local selection", { exact: true }).selectOption("Two");
    await page.getByLabel("Local selection", { exact: true }).press("ArrowUp");
    await page.getByRole("button", { name: "Save local draft", exact: true }).press("Space");
    await page.getByLabel("Local rich text", { exact: true }).click();
    await page.keyboard.type("editable-only");
    await expect(page.getByLabel("Local rich text", { exact: true })).toHaveText("editable-only");
  });
});

test("edge controls are keyboard reachable without forwarding activation keys", async ({ context, page, host }) => {
  await connect(context, page, host);
  await expectNoInput(host, page, async () => {
    await page.getByRole("button", { name: "Show session controls", exact: true }).focus();
    if (!await page.getByRole("button", { name: "Hide session controls", exact: true }).count()) await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Hide session controls", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show connection details", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary", { name: "Connection metrics" })).toBeVisible();
    await page.getByRole("button", { name: "Hide connection details", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("complementary", { name: "Connection metrics", includeHidden: true })).toBeHidden();
    await page.getByRole("button", { name: "Show keyboard controls", exact: true }).focus();
    if (!await page.getByRole("button", { name: "Hide keyboard controls", exact: true }).count()) await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Keyboard", exact: true })).toBeVisible();
  });
});

test("open shadow-root editors retain typing selection and focus without remote input", async ({ context, page, host }) => {
  await connect(context, page, host);
  await page.getByTestId("remote-console").evaluate(console => {
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;z-index:9999;top:100px;left:30px;background:white;color:black";
    const shadow = container.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Shadow local draft");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Shadow local selection");
    for (const text of ["One", "Two"]) select.add(new Option(text, text));
    const button = document.createElement("button");
    button.textContent = "Save shadow draft";
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.setAttribute("aria-label", "Shadow rich text");
    shadow.append(input, select, button, editable);
    console.append(container);
  });
  await expectNoInput(host, page, async () => {
    const input = page.getByLabel("Shadow local draft", { exact: true });
    await input.click();
    await page.keyboard.type("shadow-only");
    await expect(input).toHaveValue("shadow-only");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(input).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("shadow-onl");
    await page.getByLabel("Shadow local selection", { exact: true }).selectOption("Two");
    await page.getByLabel("Shadow local selection", { exact: true }).press("ArrowUp");
    await page.getByRole("button", { name: "Save shadow draft", exact: true }).press("Space");
    await page.getByLabel("Shadow rich text", { exact: true }).click();
    await page.keyboard.type("shadow-editor");
    await expect(page.getByLabel("Shadow rich text", { exact: true })).toHaveText("shadow-editor");
  });
});

test("unrelated focusable surfaces never opt into desktop capture or lose focus on activation", async ({ context, page, host }) => {
  await connect(context, page, host);
  await page.getByTestId("remote-console").evaluate(console => {
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    surface.setAttribute("aria-label", "Local application surface");
    surface.style.cssText = "position:fixed;z-index:9999;top:150px;left:30px;background:white;color:black";
    surface.textContent = "Local application surface";
    console.append(surface);
  });
  await expectNoInput(host, page, async () => {
    const surface = page.getByLabel("Local application surface", { exact: true });
    await surface.focus();
    await page.keyboard.type("not-a-remote-editor");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Enter");
    await expect(surface).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(surface).toBeFocused();
  });
});

test("pointer-mode changes preserve a focused local editor and never leak subsequent typing", async ({ context, page, host }) => {
  await context.addInitScript(() => {
    const query = "(hover: hover) and (pointer: fine)";
    const matchMedia = window.matchMedia.bind(window);
    const media = matchMedia(query);
    let fine = false;
    Object.defineProperty(media, "matches", { configurable: true, get: () => fine });
    window.matchMedia = candidate => candidate === query ? media : matchMedia(candidate);
    Object.defineProperty(window, "__setFinePointer", { value: (matches: boolean) => {
      fine = matches;
      media.dispatchEvent(new MediaQueryListEvent("change", { media: query, matches }));
    } });
  });
  await connect(context, page, host);
  await page.getByTestId("remote-console").evaluate(console => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Pointer-mode local editor");
    input.style.cssText = "position:fixed;z-index:9999;top:100px;left:30px";
    console.append(input);
  });
  const input = page.getByLabel("Pointer-mode local editor", { exact: true });
  await expectNoInput(host, page, async () => {
    await input.focus();
    await page.keyboard.type("local-before");
    await page.evaluate(async () => {
      (window as unknown as { __setFinePointer: (fine: boolean) => void }).__setFinePointer(true);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.keyboard.type("-local-after");
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("local-before-local-after");
});

for (const inputType of ["insertFromComposition", "insertText"]) {
  for (const lateEnd of [false, true]) {
    test(`late IME ${inputType} ${lateEnd ? "after compositionend" : "without compositionend"} cannot cross blur and fresh physical typing recovers`, async ({ context, page, host }) => {
      await connect(context, page, host);
      const input = page.getByLabel("Remote text input", { exact: true });
      await expect(input).toBeFocused();
      const cdp = await context.newCDPSession(page);
      const text = "\ud55c\uae00";
      try {
        await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
        await expect(input).toHaveValue(text);
        expect(await inputMessages(host, "__messages")).toEqual([]);
        await page.evaluate(() => {
          Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
          window.dispatchEvent(new Event("blur"));
        });
        await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
        await expect(input).toHaveValue("");
        await page.evaluate(() => {
          Reflect.deleteProperty(document, "hasFocus");
          window.dispatchEvent(new Event("focus"));
        });
        await expect(input).toBeFocused();
        await expectNoInput(host, page, async () => {
          await input.evaluate((element: HTMLTextAreaElement, { text, inputType, lateEnd }) => {
            if (lateEnd) {
              element.value = text;
              element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
            }
            element.value = text;
            element.setSelectionRange(text.length, text.length);
            element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType, isComposing: false }));
          }, { text, inputType, lateEnd });
        });
        await page.keyboard.type("fresh");
        await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text).join("")).toBe("fresh");
        expect(await inputMessages(host, "__messages")).toEqual(await inputMessages(host));
      } finally {
        await cdp.detach();
      }
    });
  }
}

for (const target of ["stage", "body"]) {
  test(`first Enter from ${target} focus sends exactly one native down/up pair`, async ({ context, page, host }) => {
    await connect(context, page, host);
    if (target === "stage") await page.getByTestId("video-stage").focus();
    else await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
    expect(await page.evaluate(target => document.activeElement === (target === "stage" ? document.querySelector('[data-testid="video-stage"]') : document.body), target)).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "key").map(({ key, down, modifiers }) => ({ key, down, modifiers }))).toEqual([
      { key: "Enter", down: true, modifiers: [] },
      { key: "Enter", down: false, modifiers: [] },
    ]);
    expect((await inputMessages(host, "__messages")).filter(message => message.type === "text")).toEqual([]);
    await expect(page.getByLabel("Remote text input", { exact: true })).toBeFocused();
  });
}

for (const action of ["toolbar blur", "fresh typing"]) {
  test(`cancelled IME staged DOM text cannot flush through ${action}`, async ({ context, page, host }) => {
    await connect(context, page, host);
    await revealSessionControls(page);
    const input = page.getByLabel("Remote text input", { exact: true });
    await expect(input).toBeFocused();
    const cdp = await context.newCDPSession(page);
    const text = "\ud55c\uae00";
    try {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await expect(input).toHaveValue(text);
      await page.evaluate(() => {
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
        window.dispatchEvent(new Event("blur"));
      });
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
      await expect(input).toHaveValue("");
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "hasFocus");
        window.dispatchEvent(new Event("focus"));
      });
      await expect(input).toBeFocused();
      // An IME may update the DOM before delivering its trailing input event.
      await input.evaluate((element: HTMLTextAreaElement, value) => {
        element.value = value;
        element.setSelectionRange(value.length, value.length);
      }, text);
      expect(await inputMessages(host, "__messages")).toEqual([]);
      if (action === "toolbar blur") {
        await expectNoInput(host, page, () => page.getByRole("button", { name: "Fit screen", exact: true }).click());
        await input.focus();
      }
      await page.keyboard.type("fresh");
      await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text).join("")).toBe("fresh");
      expect(await inputMessages(host, "__messages")).toEqual(await inputMessages(host));
    } finally {
      await cdp.detach();
    }
  });
}

test("contain letterboxing rejects remote clicks and maps the video center correctly", async ({ context, page, host }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await connect(context, page, host);
  await expectViewport(page);
  await expectNoInput(host, page, () => page.mouse.click(640, 76));
  await page.mouse.click(640, 450);
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "button").map(({ x, y, down }) => ({ x, y, down }))).toEqual([
    { x: 0.5, y: 0.5, down: true },
    { x: 0.5, y: 0.5, down: false },
  ]);
});

test("blur releases a held key and suppresses unfocused direct input until video interaction", async ({ context, page, host }) => {
  await connect(context, page, host);
  await page.keyboard.down("ArrowLeft");
  await expect.poll(async () => (await inputMessages(host)).some(message => message.key === "ArrowLeft" && message.down)).toBe(true);
  const before = await host.evaluate(() => (window as unknown as HostState).__messages.length);
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await expect.poll(() => host.evaluate(offset => (window as unknown as HostState).__messages.slice(offset).some(message => message.type === "release-all"), before)).toBe(true);
  await expectNoInput(host, page, async () => {
    await page.keyboard.up("ArrowLeft");
    await page.keyboard.type("must-not-forward-unfocused");
  });
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hasFocus");
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByTestId("video-stage").click();
  await expect(page.getByLabel("Remote text input", { exact: true })).toBeFocused();
  await page.keyboard.type("resumed");
  await expect.poll(async () => (await inputMessages(host)).filter(message => message.type === "text").map(message => message.text).join("")).toBe("resumed");
  expect(await host.evaluate(() => (window as unknown as HostState).__peerGeneration)).toBe(1);
});

test("view-only video never forwards physical keys text or composition", async ({ context, page, host }) => {
  await connect(context, page, host, "View");
  await page.getByTestId("video-stage").click();
  await expectNoInput(host, page, async () => {
    await page.keyboard.type("view-only");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("\ud55c\uae00");
  });
  expect(await inputMessages(host, "__messages")).toEqual([]);
});

test("direct capture checks hidden state before a throttled visibility callback", async ({ context, page, host }) => {
  await connect(context, page, host);
  await expect(page.getByLabel("Remote text input", { exact: true })).toBeFocused();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  });
  await expectNoInput(host, page, async () => {
    await page.keyboard.type("must-not-cross-hidden-capture");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("\ud55c\uae00");
  });
  const state = await page.request.get("/__test/state").then(response => response.json());
  expect(state.connectCount).toBe(1);
  expect(state.recoveryBodies).toEqual([]);
  expect(await host.evaluate(() => (window as unknown as HostState).__peerGeneration)).toBe(1);
});

test("absolute expiry unmounts capture and does not forward subsequent desktop input", async ({ context, page, host }) => {
  await page.clock.install();
  await page.request.post("/__test/options", { data: { sessionSeconds: 10 } });
  await connect(context, page, host);
  await page.clock.fastForward(10_001);
  await expect(page.getByRole("alert")).toContainText("Remote access expired");
  await expect(page.getByTestId("video-stage")).toHaveCount(0);
  await expect(page.getByLabel("Remote text input", { exact: true })).toHaveCount(0);
  await expectNoInput(host, page, async () => {
    await page.keyboard.type("must-not-cross-expiry");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("\ud55c\uae00");
  });
  const state = await page.request.get("/__test/state").then(response => response.json());
  expect(state.connectCount).toBe(1);
  expect(state.recoveryBodies).toEqual([]);
});
