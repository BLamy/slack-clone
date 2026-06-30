import { expect, test } from "@playwright/test";

const room = process.env.REPLAY_ROOM || "replay-durable-streams";
const peers = [
  { persona: "Ada", email: "ada@example.test", displayName: "Ada Lovelace", message: "Ada posting from Replay recording A" },
  {
    persona: "Linus",
    email: "linus@example.test",
    displayName: "Linus Torvalds",
    message: "Linus posting from Replay recording B",
  },
];

test.describe.configure({ mode: "parallel" });

for (const peer of peers) {
  test(`${peer.persona} records the shared durable stream room`, async ({ page }) => {
    await page.goto(`/?room=${room}`);
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    await expect(page.getByTestId("auth0-emulator-url")).toHaveText("http://127.0.0.1:4101");
    await page.getByTestId("email-input").fill(peer.email);
    await page.getByTestId("password-input").fill("DemoPass123");
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("auth-user")).toHaveText(peer.email);
    await expect(page.getByTestId("persona-label")).toHaveText(peer.displayName);
    await expect(page.getByTestId("auth-provider")).toContainText("Auth0 emulator");

    await expect(page.getByTestId("connection-state")).toHaveText(/live|complete/);
    await page.getByTestId("message-input").fill(peer.message);
    await page.getByTestId("send-button").click();

    for (const expected of peers) {
      await expect(page.getByText(expected.message)).toBeVisible();
      await expect(page.getByTestId("messages").getByText(expected.displayName)).toBeVisible();
    }

    await expect(page.getByTestId("stream-path")).toContainText(`/rooms/${room}/messages`);
    await expect(page.getByTestId("stream-offset")).not.toHaveText("pending");
    await page.waitForTimeout(1500);
  });
}
