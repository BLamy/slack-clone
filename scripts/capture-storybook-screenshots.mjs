import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const baseUrl = process.env.STORYBOOK_URL ?? 'http://127.0.0.1:6006';
const outputDir = path.resolve(
  'frontend/epic-0-storybook-components/evidence',
);

const stories = [
  {
    id: 'stream-slack-design-system--light-mode',
    file: 'storybook-light-mode.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-design-system--dark-mode',
    file: 'storybook-dark-mode.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-design-system--interaction-states',
    file: 'storybook-interaction-states.png',
    viewport: { width: 1280, height: 720 },
  },
  {
    id: 'stream-slack-design-system--workspace-shell',
    file: 'storybook-workspace-shell.png',
    viewport: { width: 1280, height: 720 },
  },
  {
    id: 'stream-slack-design-system--workspace-shell',
    file: 'storybook-workspace-mobile.png',
    viewport: { width: 390, height: 844 },
  },
  {
    id: 'stream-slack-messages--action-states',
    file: 'storybook-message-actions.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-messages--action-states-dark',
    file: 'storybook-message-actions-dark.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-agent-studio--directory',
    file: 'storybook-agent-directory.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-agent-studio--identity-form',
    file: 'storybook-agent-identity.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-agent-studio--identity-form',
    file: 'storybook-agent-identity-mobile.png',
    viewport: { width: 390, height: 844 },
    fullPage: true,
  },
  {
    id: 'stream-slack-agent-studio--review',
    file: 'storybook-agent-review.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
  {
    id: 'stream-slack-agent-studio--review-dark',
    file: 'storybook-agent-review-dark.png',
    viewport: { width: 1280, height: 720 },
    fullPage: true,
  },
];

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const manifest = {
  baseUrl,
  generatedAt: new Date().toISOString(),
  stories: [],
};

try {
  for (const story of stories) {
    const page = await browser.newPage({ viewport: story.viewport });
    const consoleErrors = [];
    const requestFailures = [];

    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      requestFailures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
    });

    const url = `${baseUrl}/iframe.html?id=${story.id}&viewMode=story`;
    console.log(`Capturing ${story.file} at ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const storyRoot = page.locator('#storybook-root');
    const storyRootCount = await storyRoot.count();
    if (storyRootCount !== 1) {
      throw new Error(`Expected one Storybook root, found ${storyRootCount}: ${(await page.locator('body').innerText()).slice(0, 500)}`);
    }
    await storyRoot.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(outputDir, story.file), fullPage: story.fullPage ?? false });

    if (consoleErrors.length || requestFailures.length) {
      throw new Error(
        `${story.id} produced browser failures: ${JSON.stringify({ consoleErrors, requestFailures })}`,
      );
    }

    manifest.stories.push({
      id: story.id,
      file: story.file,
      viewport: story.viewport,
      fullPage: story.fullPage ?? false,
      consoleErrors,
      requestFailures,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

await fs.writeFile(
  path.join(outputDir, 'storybook-screenshots.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`Captured ${manifest.stories.length} Storybook screenshots in ${outputDir}`);
