import { expect, test } from "@playwright/test";

async function signIn(page, room, email) {
  await page.goto(`/?room=${room}`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId("auth0-emulator-url")).toHaveText("http://127.0.0.1:4101");
  await page.getByTestId("email-input").fill(email);
  await page.getByTestId("password-input").fill("DemoPass123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(new RegExp(`127\\.0\\.0\\.1:5175/\\?room=${room}`));
  await expect(page.getByTestId("auth-user")).toHaveText(email);
}

test("two authenticated sessions in the same room see messages from each other", async ({ browser }) => {
  const room = `playwright-${Date.now()}`;
  const ada = await browser.newPage();
  const linus = await browser.newPage();

  await Promise.all([
    signIn(ada, room, "ada@example.test"),
    signIn(linus, room, "linus@example.test"),
  ]);

  await expect(ada.getByTestId("connection-state")).toHaveText(/live|complete/);
  await expect(linus.getByTestId("connection-state")).toHaveText(/live|complete/);
  await expect(ada.getByTestId("auth-provider")).toContainText("Auth0 emulator");
  await expect(linus.getByTestId("auth-provider")).toContainText("Auth0 emulator");

  await ada.getByTestId("message-input").fill("hello from Ada through durable streams");
  await ada.getByTestId("send-button").click();

  await expect(linus.getByText("hello from Ada through durable streams")).toBeVisible();
  await expect(ada.getByText("hello from Ada through durable streams")).toBeVisible();
  await expect(ada.getByTestId("messages").getByText("Ada Lovelace")).toBeVisible();

  await linus.getByTestId("message-input").fill("Linus sees it and replies");
  await linus.getByTestId("send-button").click();

  await expect(ada.getByText("Linus sees it and replies")).toBeVisible();
  await expect(linus.getByText("Linus sees it and replies")).toBeVisible();
  await expect(linus.getByTestId("messages").getByText("Linus Torvalds")).toBeVisible();

  await expect(ada.getByTestId("stream-path")).toContainText(`/rooms/${room}/messages`);
  await expect(ada.getByTestId("stream-offset")).not.toHaveText("pending");

  await ada.close();
  await linus.close();
});
