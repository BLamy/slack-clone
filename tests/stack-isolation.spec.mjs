import { expect, test } from "@playwright/test";

const stackA = {
  app: process.env.APP_BASE_URL,
  auth: process.env.AUTH0_EMULATOR_URL,
};
const stackB = {
  app: process.env.PEER_APP_BASE_URL,
  auth: process.env.PEER_AUTH0_EMULATOR_URL,
};
const room = `${process.env.TEST_ROOM_PREFIX ?? "isolation"}-same-room`;

async function signIn(page, stack, email) {
  await page.goto(`${stack.app}/app?room=${room}`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId("auth0-emulator-url")).toHaveText(stack.auth);
  await page.getByTestId("email-input").fill(email);
  await page.getByTestId("password-input").fill("DemoPass123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(`${stack.app}/app?room=${room}`);
  await expect(page.getByTestId("connection-state")).toHaveText(
    /live|complete/,
  );
}

test("assigned stacks isolate ports, sessions, streams, and browser state", async ({
  browser,
  request,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await Promise.all([
    signIn(pageA, stackA, "ada@example.test"),
    signIn(pageB, stackB, "linus@example.test"),
  ]);

  const cookieA = (await contextA.cookies(stackA.app)).find(
    (cookie) => cookie.name === "slack_clone_session",
  );
  expect(cookieA).toBeDefined();
  const foreignSession = await request.get(`${stackB.app}/api/session`, {
    headers: { Cookie: `${cookieA.name}=${cookieA.value}` },
  });
  expect(foreignSession.status()).toBe(401);

  const onlyA = `only-stack-a-${process.env.TEST_RUN_ID}`;
  await pageA.getByTestId("message-input").fill(onlyA);
  await pageA.getByTestId("send-button").click();
  await expect(pageA.getByText(onlyA)).toBeVisible();
  await pageB.waitForTimeout(800);
  await expect(pageB.getByText(onlyA)).toHaveCount(0);

  const stateB = await pageB.evaluate(async (roomId) => {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/messages`,
    );
    return response.json();
  }, room);
  expect(stateB.messages.some((message) => message.text === onlyA)).toBe(false);

  const onlyB = `only-stack-b-${process.env.TEST_RUN_ID}`;
  await pageB.getByTestId("message-input").fill(onlyB);
  await pageB.getByTestId("send-button").click();
  await expect(pageB.getByText(onlyB)).toBeVisible();
  await pageA.waitForTimeout(800);
  await expect(pageA.getByText(onlyB)).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});
