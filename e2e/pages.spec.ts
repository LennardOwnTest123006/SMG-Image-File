import { test, expect } from '@playwright/test';
import { trackErrors } from './helpers.ts';

const PAGES: Array<[string, RegExp]> = [
  ['/', /Images\.\s*Smaller\.\s*Smarter\./],
  ['/studio', /File/],
  ['/convert', /Convert to and from SMG/],
  ['/compress', /Compress images to SMG/],
  ['/format', /Specification v1\.0/],
  ['/benchmarks', /Measured, not marketed/],
  ['/docs', /SMG developer guide/],
  ['/download', /Get SMG/],
  ['/privacy', /Privacy policy/],
  ['/about', /About SMG/],
];

for (const [path, heading] of PAGES) {
  test(`renders ${path} without errors under the production CSP`, async ({ page }) => {
    const errors = trackErrors(page);
    const res = await page.goto(path);
    expect(res?.headers()['content-security-policy']).toContain("default-src 'self'");
    await expect(page.locator('main')).toContainText(heading);
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
}

test('landing page live demo encodes a real image', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.demo-stats')).toContainText(/\d+(\.\d+)? KB/, { timeout: 30_000 });
  await expect(page.locator('.demo-stats')).toContainText('%');
});

test('unknown routes show a 404 page', async ({ page }) => {
  await page.goto('/does-not-exist');
  await expect(page.locator('main')).toContainText('404');
});

test('benchmark page runs the in-browser benchmark', async ({ page }) => {
  await page.goto('/benchmarks');
  await page.getByTestId('run-live').click();
  const table = page.getByTestId('live-results');
  await expect(table).toContainText('SMG (auto)', { timeout: 60_000 });
  await expect(table).toContainText('PNG (browser)', { timeout: 60_000 });
  await expect(table).toContainText('AVIF (browser)', { timeout: 60_000 });
});

test('format page byte explorer inspects the sample file', async ({ page }) => {
  await page.goto('/format');
  await expect(page.locator('.hex')).toContainText('89 53 4d 47'.split(' ')[0]);
  await expect(page.getByText('HEAD → csum → DATA → TAIL')).toBeVisible({ timeout: 15_000 });
});

test('download page lists release files with checksums', async ({ page }) => {
  await page.goto('/download');
  await expect(page.locator('main')).toContainText(/smg-\d+\.\d+\.\d+\.mjs/);
  await expect(page.locator('main')).toContainText('SHA-256');
  const href = await page.locator('a[download$=".mjs"]').getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.ok()).toBe(true);
  expect((await res.body()).subarray(0, 19).toString()).toBe('#!/usr/bin/env node');
});

test('service worker is registered for offline use', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1500);
  const n = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(n).toBeGreaterThan(0);
});
