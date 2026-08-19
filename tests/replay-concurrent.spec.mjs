import { expect, test } from "@playwright/test";

const room = process.env.REPLAY_ROOM || "replay-durable-streams";
const peers = [
  { persona: "Ada", email: "ada@example.test", displayName: "Ada Lovelace" },
  {
    persona: "Linus",
    email: "linus@example.test",
    displayName: "Linus Torvalds",
  },
];
const conversation = [
  {
    persona: "Ada",
    delayMs: 700,
    message: "Good morning Linus, can you see this room from your Replay session?",
  },
  {
    persona: "Linus",
    delayMs: 2100,
    message: "Yes, I can see it. Your message arrived through durable streams.",
  },
  {
    persona: "Ada",
    delayMs: 3500,
    message: "Great. I am sending one more note after your reply.",
  },
  {
    persona: "Linus",
    delayMs: 4900,
    message: "Received. The second browser has the full staggered conversation.",
  },
];
const AUTH0_AUTHORIZE_URL = /http:\/\/127\.0\.0\.1:4101\/authorize/;

test.describe.configure({ mode: "parallel" });

for (const peer of peers) {
  test(`${peer.persona} records the shared durable stream room`, async ({ page }) => {
    await page.goto(`/app?room=${room}`);
    await expect(page).toHaveURL(AUTH0_AUTHORIZE_URL);
    await expect(page.getByTestId("auth0-emulator-url")).toHaveText("http://127.0.0.1:4101");
    await page.getByTestId("email-input").fill(peer.email);
    await page.getByTestId("password-input").fill("DemoPass123");
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("auth-user")).toHaveText(peer.email);
    await expect(page.getByTestId("persona-label")).toHaveText(peer.displayName);
    await expect(page.getByTestId("auth-provider")).toContainText("Auth0 emulator");

    await expect(page.getByTestId("connection-state")).toHaveText(/live|complete/);
    const exchangeStartedAt = Date.now();
    for (const line of conversation.filter((item) => item.persona === peer.persona)) {
      await page.waitForTimeout(Math.max(0, line.delayMs - (Date.now() - exchangeStartedAt)));
      await page.getByTestId("message-input").fill(line.message);
      await page.getByTestId("send-button").click();
    }

    for (const expected of conversation) {
      await expect(page.getByText(expected.message)).toBeVisible();
    }
    for (const expected of peers) {
      await expect(page.getByTestId("messages").getByText(expected.displayName).first()).toBeVisible();
    }

    await expect(page.getByTestId("stream-path")).toContainText(`/rooms/${room}/messages`);
    await expect(page.getByTestId("stream-offset")).not.toHaveText("pending");
    await page.waitForTimeout(1500);
  });
}
