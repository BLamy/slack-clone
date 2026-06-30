import { expect, test } from "@playwright/test";

const room = process.env.REPLAY_ROOM || "replay-durable-streams";
const peers = [
  { persona: "Ada", message: "Ada posting from Replay recording A" },
  { persona: "Linus", message: "Linus posting from Replay recording B" },
];

test.describe.configure({ mode: "parallel" });

for (const peer of peers) {
  test(`${peer.persona} records the shared durable stream room`, async ({ page }) => {
    await page.goto(`/?room=${room}&persona=${peer.persona}`);

    await expect(page.getByTestId("connection-state")).toHaveText(/live|complete/);
    await page.getByTestId("message-input").fill(peer.message);
    await page.getByTestId("send-button").click();

    for (const expected of peers) {
      await expect(page.getByText(expected.message)).toBeVisible();
    }

    await expect(page.getByTestId("stream-path")).toContainText(`/rooms/${room}/messages`);
    await expect(page.getByTestId("stream-offset")).not.toHaveText("pending");
    await page.waitForTimeout(1500);
  });
}
