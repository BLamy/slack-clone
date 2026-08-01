async (page) => {
  const consoleErrors = [];
  const consoleWarnings = [];
  const requestFailures = [];
  const responseFailures = [];
  const responseStatuses = new Set();

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning") consoleWarnings.push(message.text());
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      failure: request.failure()?.errorText ?? "unknown",
    });
  });
  page.on("response", (response) => {
    responseStatuses.add(response.status());
    if (response.status() >= 400) {
      responseFailures.push({ url: response.url(), status: response.status() });
    }
  });

  await page.evaluate(() => console.info("E0-T01 interrogable Replay proof"));
  const heading = page.getByRole("heading", {
    name: /Slack-style room backed by BLamy\/emulate/,
  });
  await heading.waitFor();
  const landingUrl = page.url();
  await page.getByTestId("home-open-chat").click();
  await page.waitForURL(/\/login\?returnTo=/);

  await page.getByTestId("password-input").fill("incorrect-password");
  await page.getByTestId("login-button").click();
  await page.getByTestId("login-error").waitFor();
  const loginError = (await page.getByTestId("login-error").textContent()).trim();
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/app\?room=demo/);
  await page.getByTestId("message-input").waitFor();
  await page.waitForFunction(
    () => document.querySelector("[data-testid='connection-state']")?.textContent === "live",
  );

  const runId = Date.now().toString(36);
  const original = `Replay proof ${runId} before edit`;
  const updated = `Replay proof ${runId} after durable edit`;
  await page.getByTestId("message-input").fill(original);
  await page.getByTestId("send-button").click();
  const message = page.getByTestId("message").filter({ hasText: original });
  await message.waitFor();
  const messageId = await message.getAttribute("data-message-id");
  if (!messageId) throw new Error("created message has no stable id");

  async function compareStreamState() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dom = {
        offset: (await page.getByTestId("stream-offset").textContent()).trim(),
        digest: (await page.getByTestId("stream-digest").textContent()).trim(),
      };
      const api = await page.evaluate(async () => {
        const response = await fetch("/api/rooms/demo/messages");
        if (!response.ok) throw new Error(`stream API returned ${response.status}`);
        return response.json();
      });
      if (dom.offset === api.nextOffset && dom.digest === api.streamDigest) {
        if (!/^sha256:[0-9a-f]{64}$/.test(dom.digest)) {
          throw new Error(`non-canonical stream digest ${dom.digest}`);
        }
        return {
          dom,
          api: { nextOffset: api.nextOffset, streamDigest: api.streamDigest },
        };
      }
      await page.waitForTimeout(100);
    }
    throw new Error("DOM stream offset/digest did not converge with the authenticated API");
  }

  const afterAppend = await compareStreamState();

  await message.getByRole("button", { name: "Edit message" }).click();
  await page.getByTestId("edit-message-input").fill(`Cancelled Replay draft ${runId}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByText(original, { exact: true }).waitFor();

  const patchPattern = `**/api/rooms/demo/messages/${messageId}`;
  await page.route(patchPattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "simulated edit failure" }),
    });
  });
  await message.getByRole("button", { name: "Edit message" }).click();
  const failedDraft = `Failed Replay draft ${runId}`;
  await page.getByTestId("edit-message-input").fill(failedDraft);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='connection-state']")?.textContent ===
      "simulated edit failure",
  );
  const preservedFailedDraft = await page.getByTestId("edit-message-input").inputValue();
  await page.unroute(patchPattern);
  await page.getByRole("button", { name: "Cancel" }).click();

  await message.getByRole("button", { name: "Edit message" }).click();
  await page.getByTestId("edit-message-input").fill(updated);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText(updated, { exact: true }).waitFor();
  await page.getByTestId("message-edited").waitFor();
  await page.waitForFunction(
    () => document.querySelector("[data-testid='connection-state']")?.textContent === "live",
  );
  const afterEdit = await compareStreamState();

  const legacyId = `legacy-${runId}`;
  const legacyText = `Readable legacy record ${runId} with colliding Ada display name`;
  const streamUrl = "http://127.0.0.1:4100/rooms/demo/messages";
  const seeded = await page.context().request.post(streamUrl, {
    headers: { Authorization: "Bearer test_token_admin" },
    data: {
      id: legacyId,
      room: "demo",
      user: "Ada Lovelace",
      text: legacyText,
      createdAt: new Date().toISOString(),
    },
  });
  if (![200, 204].includes(seeded.status())) {
    throw new Error(`legacy seed failed with ${seeded.status()}`);
  }
  const legacyMessage = page.getByTestId("message").filter({ hasText: legacyText });
  await legacyMessage.waitFor();
  const legacyEditButtons = await legacyMessage
    .getByRole("button", { name: "Edit message" })
    .count();
  if (legacyEditButtons !== 0) {
    throw new Error("legacy display-name record exposed an edit control");
  }

  const denied = await page.context().request.patch(
    `http://127.0.0.1:5175/api/rooms/demo/messages/${encodeURIComponent(legacyId)}`,
    { data: { text: "Display-name collision must not grant ownership" } },
  );
  if (denied.status() !== 403) {
    throw new Error(`legacy spoof PATCH returned ${denied.status()}, expected 403`);
  }
  await page.getByText(legacyText, { exact: true }).waitFor();
  const finalState = await compareStreamState();

  await page.waitForTimeout(500);
  if (preservedFailedDraft !== failedDraft) {
    throw new Error("handled edit failure did not preserve its draft");
  }
  if (consoleErrors.length > 0) {
    throw new Error(`console errors: ${JSON.stringify(consoleErrors)}`);
  }
  if (consoleWarnings.length > 0) {
    throw new Error(`console warnings: ${JSON.stringify(consoleWarnings)}`);
  }
  if (requestFailures.length > 0) {
    throw new Error(`request failures: ${JSON.stringify(requestFailures)}`);
  }
  if (responseFailures.length > 0) {
    throw new Error(`non-success page responses: ${JSON.stringify(responseFailures)}`);
  }

  return {
    landingUrl,
    loginError,
    runId,
    messageId,
    afterAppend,
    cancelledDraftPersisted: false,
    handledEditError: {
      message: "simulated edit failure",
      draft: preservedFailedDraft,
      transportStatus: 200,
    },
    recoveredConnectionState: (
      await page.getByTestId("connection-state").textContent()
    ).trim(),
    afterEdit,
    legacyIdentityAttack: {
      id: legacyId,
      editButtons: legacyEditButtons,
      patchStatus: denied.status(),
    },
    finalState,
    consoleErrors,
    consoleWarnings,
    requestFailures,
    responseFailures,
    responseStatuses: [...responseStatuses].sort((left, right) => left - right),
  };
}
