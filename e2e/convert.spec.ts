import { test, expect } from '@playwright/test';
import { decode, pixelsEqual } from '../packages/codec/src/index.ts';
import { decodePng } from '../packages/codec/src/io/index.ts';
import fs from 'node:fs';
import { downloadBytes, expectSmgSignature, fixture, tmpFile, trackErrors, upload } from './helpers.ts';

test('PNG to SMG (lossless) to PNG round trip is bit-exact', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/convert');
  await page.locator('#smg-preset').selectOption('screenshot');
  await upload(page, fixture('screenshot.png'));
  await expect(page.getByTestId('file-row')).toContainText('1280×800');
  await page.getByTestId('convert-btn').click();
  await expect(page.getByTestId('row-result')).toBeVisible({ timeout: 90_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('row-download').click()]);
  const smgBytes = await downloadBytes(dl);
  expectSmgSignature(smgBytes);
  const src = decodePng(new Uint8Array(fs.readFileSync(fixture('screenshot.png'))));
  expect(pixelsEqual(decode(smgBytes).image, src.image)).toBe(true);

  // Now convert the .smg back to PNG in the browser.
  const smgPath = tmpFile('screenshot.smg');
  fs.writeFileSync(smgPath, smgBytes);
  await page.getByRole('button', { name: 'Clear list' }).click();
  await page.getByRole('radio', { name: 'PNG' }).click();
  await upload(page, smgPath);
  await expect(page.getByTestId('file-row')).toContainText('SMG');
  await page.getByTestId('convert-btn').click();
  await expect(page.getByTestId('row-result')).toBeVisible({ timeout: 60_000 });
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByTestId('row-download').click()]);
  expect(dl2.suggestedFilename()).toBe('screenshot.png');
  const png = decodePng(await downloadBytes(dl2));
  expect(pixelsEqual(png.image, src.image)).toBe(true);
  expect(errors).toEqual([]);
});

test('inspects SMG metadata', async ({ page }) => {
  await page.goto('/convert');
  await upload(page, 'apps/web/public/samples/cat.smg');
  await page.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByRole('dialog')).toContainText('SMG-W');
  await expect(page.getByRole('dialog')).toContainText('HEAD');
  await expect(page.getByRole('dialog')).toContainText('TAIL');
});

test('extracts GIF frames and rasterises SVG', async ({ page }) => {
  await page.goto('/convert');
  await page.locator('#smg-preset').selectOption('archive');
  await upload(page, [fixture('anim.gif'), fixture('shape.svg')]);
  await expect(page.getByTestId('file-row').nth(0)).toContainText('3 frames');
  await expect(page.getByTestId('file-row').nth(1)).toContainText('100×50');
  await page.getByLabel('SVG width').fill('400');
  await page.getByLabel('SVG height').fill('200');
  await page.getByLabel('SVG height').blur();
  await expect(page.getByTestId('file-row').nth(1)).toContainText('400×200');
  await page.getByTestId('convert-btn').click();
  await expect(page.getByTestId('file-row').nth(0)).toContainText('ZIP (3)', { timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-row').nth(1).getByTestId('row-download').click()]);
  const d = decode(await downloadBytes(dl));
  expect([d.image.width, d.image.height]).toEqual([400, 200]);
});

test('rejects corrupt files with a clear message', async ({ page }) => {
  await page.goto('/convert');
  const bad = tmpFile('broken.smg');
  const good = fs.readFileSync('apps/web/public/samples/cat.smg');
  fs.writeFileSync(bad, good.subarray(0, 500));
  await upload(page, bad);
  await expect(page.getByTestId('file-row')).toContainText(/truncated/i);
});
