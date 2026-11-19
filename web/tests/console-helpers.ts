import { expect, type Page } from "@playwright/test";

export async function revealSessionControls(page: Page) {
  await expect(page.getByTestId("remote-console")).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, 1);
  await expect(page.getByRole("button", { name: "Hide session controls", exact: true })).toBeVisible();
  await expect(page.locator(".remote-header")).toHaveCSS("opacity", "1");
}

export async function revealKeyboardControls(page: Page) {
  await expect(page.getByTestId("remote-console")).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, viewport.height - 1);
  await expect(page.getByRole("button", { name: "Hide keyboard controls", exact: true }),
    await page.evaluate(() => JSON.stringify({
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY },
      edgeTargets: document.elementsFromPoint(innerWidth / 2, innerHeight - 1).map(element => ({ tag: element.tagName, class: element.className })),
      geometry: [".remote-shell", ".remote-main", ".video-stage", ".dock-layer", ".control-dock", ".keyboard-capture"].map(selector => {
        const element = document.querySelector<HTMLElement>(selector);
        return element && { selector, bounds: element.getBoundingClientRect().toJSON(), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
      }),
    })),
  ).toBeVisible();
  await expect(page.locator(".control-dock")).toHaveCSS("opacity", "1");
}

export async function revealConnectionDetails(page: Page) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 1, viewport.height / 2);
  await page.getByRole("button", { name: "Show connection details", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Connection metrics" })).toBeVisible();
}

export async function openRemoteKeyboard(page: Page) {
  await revealKeyboardControls(page);
  const input = page.getByRole("textbox", { name: "Remote text input", exact: true });
  const bounds = await input.boundingBox();
  if (!bounds || bounds.width <= 1) await page.getByRole("button", { name: "Keyboard", exact: true }).click();
  await expect.poll(async () => (await input.boundingBox())?.width ?? 0).toBeGreaterThan(1);
  return input;
}
