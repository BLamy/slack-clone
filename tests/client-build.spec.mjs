import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const assetsDir = path.resolve('dist/client/assets');

test('client build is minified and route-split', async () => {
  const assets = await readdir(assetsDir);
  const javascript = assets.filter((asset) => asset.endsWith('.js'));
  const routeChunks = ['chat-page', 'home-page', 'login-page'].map((route) => javascript.find((asset) => asset.startsWith(`${route}-`)));

  expect(javascript.length).toBeGreaterThan(3);
  expect(routeChunks.every(Boolean)).toBe(true);

  const entry = await readFile(path.join(assetsDir, javascript.find((asset) => asset.startsWith('index-'))), 'utf8');
  expect(entry.length).toBeLessThan(250_000);
  expect(entry).not.toContain('function route()');

  for (const routeChunk of routeChunks) {
    const source = await readFile(path.join(assetsDir, routeChunk), 'utf8');
    expect(source).not.toMatch(/\n\s*\n/);
  }
});
