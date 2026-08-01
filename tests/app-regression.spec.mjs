import { expect, test } from '@playwright/test';

async function signIn(page, room, email, path = '/app') {
  await page.goto(`${path}?room=${room}`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId('auth0-emulator-url')).toHaveText('http://127.0.0.1:4101');
  await page.getByTestId('email-input').fill(email);
  await page.getByTestId('password-input').fill('DemoPass123');
  await page.getByTestId('login-button').click();
  await expect(page).toHaveURL(new RegExp(`127\\.0\\.0\\.1:5175${path}\\?room=${room}`));
  await expect(page.getByTestId('auth-user')).toHaveText(email);
}

function trackBrowserHealth(page) {
  const consoleErrors = [];
  const requestFailures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('requestfailed', (request) => requestFailures.push(`${request.method()} ${request.url()}`));
  return { consoleErrors, requestFailures };
}

test('homepage leads through emulator login into the React chat', async ({ page }) => {
  const health = trackBrowserHealth(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Slack-style room backed by BLamy\/emulate/ })).toBeVisible();
  await page.getByTestId('home-open-chat').click();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.getByTestId('email-input').fill('ada@example.test');
  await page.getByTestId('password-input').fill('DemoPass123');
  await page.getByTestId('login-button').click();
  await expect(page).toHaveURL(/\/app\?room=demo/);
  await expect(page.getByRole('heading', { level: 1, name: '# demo' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message to channel' })).toBeVisible();
  await expect(page.getByTestId('connection-state')).toHaveText(/live|complete/);
  await expect(page.getByTestId('stream-path')).toContainText('/rooms/demo/messages');
  expect(health.consoleErrors).toEqual([]);
  expect(health.requestFailures).toEqual([]);
});

test('unauthenticated app routes return to the emulator login', async ({ page }) => {
  await page.goto('/app?room=auth-gate-check');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId('login-form')).toBeVisible();
});

test('login errors preserve the React form layout', async ({ page }) => {
  await page.goto('/login?returnTo=%2Fapp%3Froom%3Ddemo');
  await expect(page.getByTestId('email-input')).toHaveValue('');
  const before = await page.getByTestId('login-form').boundingBox();
  await page.getByTestId('password-input').fill('incorrect-password');
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
  const after = await page.getByTestId('login-form').boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after.y).toBeCloseTo(before.y, 0);
});

test('owners can edit and delete messages while another user is forbidden', async ({ browser }) => {
  const room = `react-actions-${Date.now()}`;
  const adaContext = await browser.newContext();
  const linusContext = await browser.newContext();
  const ada = await adaContext.newPage();
  const linus = await linusContext.newPage();
  const original = 'A durable message before editing';
  const updated = 'The durable message after editing';

  await Promise.all([
    signIn(ada, room, 'ada@example.test'),
    signIn(linus, room, 'linus@example.test'),
  ]);
  await Promise.all([
    expect(ada.getByTestId('connection-state')).toHaveText(/live|complete/),
    expect(linus.getByTestId('connection-state')).toHaveText(/live|complete/),
  ]);

  await ada.getByTestId('message-input').fill(original);
  await ada.getByTestId('send-button').click();
  const originalMessage = ada.getByTestId('message').filter({ hasText: original });
  await expect(originalMessage).toBeVisible();
  await expect(linus.getByText(original)).toBeVisible();
  const messageId = await originalMessage.getAttribute('data-message-id');
  expect(messageId).not.toBeNull();

  const forbidden = await linus.evaluate(async ({ room, messageId }) => {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Linus should not be able to edit this' }),
    });
    return { status: response.status, body: await response.json() };
  }, { room, messageId });
  expect(forbidden.status).toBe(403);

  await originalMessage.getByRole('button', { name: 'Edit message' }).click();
  await expect(ada.getByTestId('edit-message-input')).toHaveValue(original);
  await ada.getByTestId('edit-message-input').fill(updated);
  await ada.getByRole('button', { name: 'Save edit' }).click();
  await expect(ada.getByText(updated)).toBeVisible();
  await expect(ada.getByText(original)).not.toBeVisible();
  await expect(ada.getByTestId('message-edited')).toBeVisible();
  await expect(linus.getByText(updated)).toBeVisible();
  await expect(linus.getByText(original)).not.toBeVisible();
  await expect(linus.getByTestId('message').filter({ hasText: updated }).getByRole('button', { name: 'Edit message' })).toHaveCount(0);

  await ada.reload();
  await expect(ada.getByText(updated)).toBeVisible();
  await expect(ada.getByTestId('message-edited')).toBeVisible();

  const updatedMessage = ada.getByTestId('message').filter({ hasText: updated });
  await updatedMessage.getByRole('button', { name: 'Delete message' }).click();
  const dialog = ada.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete this message?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete message' }).click();
  await expect(ada.getByText(updated)).not.toBeVisible();
  await expect(linus.getByText(updated)).not.toBeVisible();

  await adaContext.close();
  await linusContext.close();
});

test('thread entry opens the AI response and full run logs', async ({ page }) => {
  const room = `thread-${Date.now()}`;
  await signIn(page, room, 'ada@example.test');
  await page.getByRole('button', { name: 'Open threads' }).click();
  await expect(page.getByRole('region', { name: 'Thread view with agent run logs' })).toBeVisible();
  const response = page.getByRole('button', { name: 'Open full run logs for Release concierge' });
  await response.press('Enter');
  await expect(page.getByRole('heading', { name: 'Full run logs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Run timeline' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Raw log' })).toContainText('secrets=[redacted]');
  await page.getByRole('button', { name: 'Close run logs' }).click();
  await expect(page.getByRole('heading', { name: 'Inspect an agent response' })).toBeVisible();
  await page.getByRole('button', { name: 'Close thread' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `# ${room}` })).toBeVisible();
});
