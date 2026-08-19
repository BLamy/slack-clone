import { expect, test } from "@playwright/test";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:5175";
const AUTH0_EMULATOR_URL =
  process.env.AUTH0_EMULATOR_URL ?? "http://127.0.0.1:4101";
const diagnostics = new WeakMap();

test.beforeEach(({ page }) => {
  const state = { consoleErrors: [], failedRequests: [], pageErrors: [] };
  diagnostics.set(page, state);
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    state.failedRequests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
});

test.afterEach(({ page }) => {
  const state = diagnostics.get(page);
  expect(state?.consoleErrors ?? []).toEqual([]);
  expect(state?.pageErrors ?? []).toEqual([]);
  expect(state?.failedRequests ?? []).toEqual([]);
});

async function signIn(page, room, email = "ada@example.test") {
  await page.goto(`/app?room=${room}`);
  await expect(page).toHaveURL(
    new RegExp(
      `${AUTH0_EMULATOR_URL.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}/authorize`,
    ),
  );
  await page.getByTestId("email-input").fill(email);
  await page.getByTestId("password-input").fill("DemoPass123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(`${APP_BASE_URL}/app?room=${room}`);
  await expect(page.getByTestId("auth-user")).toHaveText(email);
  await expect(page.getByTestId("connection-state")).toHaveText(
    /live|complete/,
  );
}

function uniqueRoom(prefix) {
  return `replay-fix-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("owned message rows activate editing from body clicks and keyboard", async ({
  page,
}) => {
  const room = uniqueRoom("row");
  const text = "Message row activation regression";
  await signIn(page, room);

  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("send-button").click();
  const message = page.getByTestId("message").filter({ hasText: text });
  await expect(message).toBeVisible();
  await expect(message).toHaveAttribute("tabindex", "0");

  await message.locator(".message__text").click();
  await expect(page.getByTestId("edit-message-input")).toHaveValue(text);
  await page.getByRole("button", { name: "Cancel" }).click();

  await message.focus();
  await message.press("Enter");
  await expect(page.getByTestId("edit-message-input")).toHaveValue(text);
});

test("typing a mention opens a directory-backed autocomplete menu", async ({
  page,
}) => {
  await signIn(page, uniqueRoom("mention"));
  const input = page.getByTestId("message-input");
  const popover = page.getByTestId("mention-popover");

  await input.fill("@a");
  await expect(popover).toBeVisible();
  await expect(
    popover.getByRole("option", { name: /@ada Ada Lovelace/ }),
  ).toBeVisible();

  await input.press("Enter");
  await expect(input).toHaveValue("@ada ");
  await expect(popover).toBeHidden();
});

test("the digest update does not move the details panel", async ({ page }) => {
  await signIn(page, uniqueRoom("digest"));
  const layout = await page.evaluate(() => {
    const details = document.querySelector(".details");
    const digest = document.querySelector("[data-testid='stream-digest']");
    if (!details || !digest)
      throw new Error("details digest markup is missing");

    digest.textContent = "pending";
    const pendingTop = details.getBoundingClientRect().top;
    digest.textContent = `sha256:${"a".repeat(64)}`;
    const loadedTop = details.getBoundingClientRect().top;
    return {
      digestHeight: digest.getBoundingClientRect().height,
      delta: loadedTop - pendingTop,
    };
  });

  expect(layout.digestHeight).toBeGreaterThanOrEqual(50);
  expect(Math.abs(layout.delta)).toBeLessThan(1);
});

test("the edited label meets AA contrast against its white backdrop", async ({
  page,
}) => {
  const room = uniqueRoom("contrast");
  const original = "Contrast before edit";
  await signIn(page, room);

  await page.getByTestId("message-input").fill(original);
  await page.getByTestId("send-button").click();
  const message = page.getByTestId("message").filter({ hasText: original });
  await expect(message).toBeVisible();
  await message.getByRole("button", { name: "Edit message" }).click();
  await page.getByTestId("edit-message-input").fill("Contrast after edit");
  await page.getByRole("button", { name: "Save" }).click();
  const edited = page.getByTestId("message-edited");
  await expect(edited).toBeVisible();
  await expect
    .poll(() => edited.evaluate((element) => getComputedStyle(element).color))
    .toMatch(/rgb/);

  const ratio = await edited.evaluate((element) => {
    const color = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g);
    if (!color || color.length < 3) throw new Error("edited color is missing");
    const channels = color
      .slice(0, 3)
      .map(Number)
      .map((channel) => {
        const value = channel / 255;
        return value <= 0.03928
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
    const luminance =
      channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    return 1.05 / (luminance + 0.05);
  });

  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
