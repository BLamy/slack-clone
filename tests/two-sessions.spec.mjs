import { expect, test } from "@playwright/test";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://127.0.0.1:5175";
const AUTH0_EMULATOR_URL =
  process.env.AUTH0_EMULATOR_URL ?? "http://127.0.0.1:4101";
const DURABLE_STREAMS_URL =
  process.env.DURABLE_STREAMS_URL ?? "http://127.0.0.1:4100";
const ROOM_PREFIX = process.env.TEST_ROOM_PREFIX ?? "playwright";

async function signIn(page, room, email) {
  await page.goto(`/app?room=${room}`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId("auth0-emulator-url")).toHaveText(
    AUTH0_EMULATOR_URL,
  );
  await page.getByTestId("email-input").fill(email);
  await page.getByTestId("password-input").fill("DemoPass123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(`${APP_BASE_URL}/app?room=${room}`);
  await expect(page.getByTestId("auth-user")).toHaveText(email);
}

async function seedLegacyMessage(room, record) {
  const url = `${DURABLE_STREAMS_URL}/rooms/${encodeURIComponent(room)}/messages`;
  const headers = {
    Authorization: "Bearer test_token_admin",
    "Content-Type": "application/json",
  };
  const create = await fetch(url, { method: "PUT", headers, body: "[]" });
  expect([200, 201]).toContain(create.status);
  const append = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(record),
  });
  expect([200, 204]).toContain(append.status);
}

test("homepage sends a user through the emulator login into the chat", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: /Slack-style room backed by BLamy\/emulate/,
    }),
  ).toBeVisible();
  await page.getByTestId("home-open-chat").click();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId("auth0-emulator-url")).toHaveText(
    AUTH0_EMULATOR_URL,
  );
  await page.getByTestId("email-input").fill("ada@example.test");
  await page.getByTestId("password-input").fill("DemoPass123");
  await page.getByTestId("login-button").click();

  await expect(page).toHaveURL(/\/app\?room=demo/);
  await expect(
    page.getByRole("heading", { level: 1, name: "# demo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message to channel" }),
  ).toBeVisible();
  await expect(page.getByTestId("auth-user")).toHaveText("ada@example.test");
  await expect(page.getByTestId("connection-state")).toHaveText(
    /live|complete/,
  );
  await expect(page.getByTestId("stream-path")).toContainText(
    "/rooms/demo/messages",
  );
  await expect(page.getByTestId("stream-digest")).toHaveText(
    /^sha256:[0-9a-f]{64}$/,
  );
  const streamState = await page.evaluate(async () => {
    const response = await fetch("/api/rooms/demo/messages");
    return response.json();
  });
  await expect(page.getByTestId("stream-digest")).toHaveText(
    streamState.streamDigest,
  );
});

test("login errors do not move the form", async ({ page }) => {
  await page.goto("/login?returnTo=%2Fapp%3Froom%3Ddemo");
  const before = await page.getByTestId("login-form").boundingBox();

  await page.getByTestId("password-input").fill("incorrect-password");
  await page.getByTestId("login-button").click();

  await expect(page.getByTestId("login-error")).toBeVisible();
  const after = await page.getByTestId("login-form").boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after.y).toBeCloseTo(before.y, 0);
});

test("two authenticated sessions in the same room see messages from each other", async ({
  browser,
}) => {
  const room = `${ROOM_PREFIX}-playwright-${Date.now()}`;
  const ada = await browser.newPage();
  const linus = await browser.newPage();

  await Promise.all([
    signIn(ada, room, "ada@example.test"),
    signIn(linus, room, "linus@example.test"),
  ]);

  await expect(ada.getByTestId("connection-state")).toHaveText(/live|complete/);
  await expect(linus.getByTestId("connection-state")).toHaveText(
    /live|complete/,
  );
  await expect(ada.getByTestId("auth-provider")).toContainText(
    "Auth0 emulator",
  );
  await expect(linus.getByTestId("auth-provider")).toContainText(
    "Auth0 emulator",
  );

  await ada
    .getByTestId("message-input")
    .fill("hello from Ada through durable streams");
  await ada.getByTestId("send-button").click();

  await expect(
    linus.getByText("hello from Ada through durable streams"),
  ).toBeVisible();
  await expect(
    ada.getByText("hello from Ada through durable streams"),
  ).toBeVisible();
  await expect(
    ada.getByTestId("messages").getByText("Ada Lovelace"),
  ).toBeVisible();

  await linus.getByTestId("message-input").fill("Linus sees it and replies");
  await linus.getByTestId("send-button").click();

  await expect(ada.getByText("Linus sees it and replies")).toBeVisible();
  await expect(linus.getByText("Linus sees it and replies")).toBeVisible();
  await expect(
    linus.getByTestId("messages").getByText("Linus Torvalds"),
  ).toBeVisible();

  await expect(ada.getByTestId("stream-path")).toContainText(
    `/rooms/${room}/messages`,
  );
  await expect(ada.getByTestId("stream-offset")).not.toHaveText("pending");

  await ada.close();
  await linus.close();
});

test("a user can edit their message and the update persists across sessions", async ({
  browser,
}) => {
  const room = `${ROOM_PREFIX}-edit-${Date.now()}`;
  const adaContext = await browser.newContext();
  const linusContext = await browser.newContext();
  const ada = await adaContext.newPage();
  const linus = await linusContext.newPage();
  const original = "A durable message before editing";
  const updated = "The durable message after editing";

  await Promise.all([
    signIn(ada, room, "ada@example.test"),
    signIn(linus, room, "linus@example.test"),
  ]);
  await Promise.all([
    expect(ada.getByTestId("connection-state")).toHaveText(/live|complete/),
    expect(linus.getByTestId("connection-state")).toHaveText(/live|complete/),
  ]);

  await ada.getByTestId("message-input").fill(original);
  await ada.getByTestId("send-button").click();
  const originalMessage = ada
    .getByTestId("message")
    .filter({ hasText: original });
  await expect(originalMessage).toBeVisible();
  await expect(linus.getByText(original)).toBeVisible();
  const messageId = await originalMessage.getAttribute("data-message-id");
  expect(messageId).not.toBeNull();
  const forbidden = await linus.evaluate(
    async ({ room, messageId }) => {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Linus should not be able to edit this",
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { room, messageId },
  );
  expect(forbidden.status).toBe(403);

  await originalMessage.getByRole("button", { name: "Edit message" }).click();
  await expect(ada.getByTestId("edit-message-input")).toHaveValue(original);
  await ada
    .getByTestId("edit-message-input")
    .fill("This cancelled draft must not persist");
  await ada.getByRole("button", { name: "Cancel" }).click();
  await expect(ada.getByTestId("edit-message-input")).toHaveCount(0);
  await expect(ada.getByText(original)).toBeVisible();

  await ada.route(
    `**/api/rooms/${room}/messages/${messageId}`,
    async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "simulated edit failure" }),
      });
    },
    { times: 1 },
  );
  await originalMessage.getByRole("button", { name: "Edit message" }).click();
  await ada
    .getByTestId("edit-message-input")
    .fill("This failed draft must not persist");
  await ada.getByRole("button", { name: "Save" }).click();
  await expect(ada.getByTestId("connection-state")).toHaveText(
    "simulated edit failure",
  );
  await expect(ada.getByTestId("edit-message-input")).toHaveValue(
    "This failed draft must not persist",
  );
  await ada.getByRole("button", { name: "Cancel" }).click();
  await expect(ada.getByText(original)).toBeVisible();

  await originalMessage.getByRole("button", { name: "Edit message" }).click();
  await ada.getByTestId("edit-message-input").fill(updated);
  await ada.getByRole("button", { name: "Save" }).click();

  await expect(ada.getByText(updated)).toBeVisible();
  await expect(ada.getByText(original)).not.toBeVisible();
  await expect(ada.getByTestId("message-edited")).toBeVisible();
  await expect(ada.getByTestId("connection-state")).toHaveText("live");
  await expect(linus.getByText(updated)).toBeVisible();
  await expect(linus.getByText(original)).not.toBeVisible();
  await expect(
    linus
      .getByTestId("message")
      .filter({ hasText: updated })
      .getByRole("button", { name: "Edit message" }),
  ).toHaveCount(0);

  await ada.reload();
  await expect(ada.getByText(updated)).toBeVisible();
  await expect(ada.getByText(original)).not.toBeVisible();
  await expect(ada.getByTestId("message-edited")).toBeVisible();

  const streamState = await ada.evaluate(async (roomId) => {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/messages`,
    );
    return response.json();
  }, room);
  expect(streamState.streamDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  await expect(ada.getByTestId("stream-digest")).toHaveText(
    streamState.streamDigest,
  );

  await adaContext.close();
  await linusContext.close();
});

test("legacy display-name-only messages stay readable but cannot be edited", async ({
  page,
}) => {
  const room = `${ROOM_PREFIX}-legacy-${Date.now()}`;
  const messageId = `legacy-${crypto.randomUUID()}`;
  const text = "A readable legacy message without stable ownership";
  await seedLegacyMessage(room, {
    id: messageId,
    room,
    user: "Ada Lovelace",
    text,
    createdAt: new Date().toISOString(),
  });

  await signIn(page, room, "ada@example.test");
  const message = page.getByTestId("message").filter({ hasText: text });
  await expect(message).toBeVisible();
  await expect(
    message.getByRole("button", { name: "Edit message" }),
  ).toHaveCount(0);

  const denied = await page.evaluate(
    async ({ roomId, id }) => {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Display-name collision must not grant ownership",
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { roomId: room, id: messageId },
  );
  expect(denied.status).toBe(403);
  await expect(message.getByText(text)).toBeVisible();
});
