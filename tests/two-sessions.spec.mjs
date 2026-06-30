import { expect, test } from "@playwright/test";

test("two sessions in the same room see messages from each other", async ({ browser, request }) => {
  const room = `playwright-${Date.now()}`;
  await request.delete(`/api/rooms/${room}/messages`);

  const ada = await browser.newPage();
  const linus = await browser.newPage();

  await Promise.all([
    ada.goto(`/?room=${room}&persona=Ada`),
    linus.goto(`/?room=${room}&persona=Linus`),
  ]);

  await expect(ada.getByTestId("connection-state")).toHaveText(/live|complete/);
  await expect(linus.getByTestId("connection-state")).toHaveText(/live|complete/);

  await ada.getByTestId("message-input").fill("hello from Ada through durable streams");
  await ada.getByTestId("send-button").click();

  await expect(linus.getByText("hello from Ada through durable streams")).toBeVisible();
  await expect(ada.getByText("hello from Ada through durable streams")).toBeVisible();

  await linus.getByTestId("message-input").fill("Linus sees it and replies");
  await linus.getByTestId("send-button").click();

  await expect(ada.getByText("Linus sees it and replies")).toBeVisible();
  await expect(linus.getByText("Linus sees it and replies")).toBeVisible();

  await expect(ada.getByTestId("stream-path")).toContainText(`/rooms/${room}/messages`);
  await expect(ada.getByTestId("stream-offset")).not.toHaveText("pending");

  await ada.close();
  await linus.close();
});
