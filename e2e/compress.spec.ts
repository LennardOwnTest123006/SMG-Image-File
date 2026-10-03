import { test, expect } from '@playwright/test';
import { decode, pixelsEqual } from '../packages/codec/src/index.ts';
import { decodePng } from '../packages/codec/src/io/index.ts';
import fs from 'node:fs';
import { downloadBytes, expectSmgSignature, fixture, trackErrors, upload } from './helpers.ts';

test('compresses a photo to SMG with real statistics', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/compress');
  await upload(page, fixture('photo.png'));
  await expect(page.getByTestId('estimate')).toContainText('≈', { timeout: 60_000 });
  await page.getByTestId('compress-btn').click();
  const results = page.getByTestId('results');
  await expect(results).toBeVisible({ timeout: 60_000 });
  await expect(results).toContainText('SMG-W');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-btn').click()]);
  expect(dl.suggestedFilename()).toBe('photo.smg');
  const bytes = await downloadBytes(dl);
  expectSmgSignature(bytes);
  const shown = await page.getByTestId('smg-size').textContent();
  const kb = (bytes.length / 1000).toFixed(1);
  expect(shown).toContain(kb.endsWith('.0') && bytes.length >= 100_000 ? kb.split('.')[0] : kb);
  const d = decode(bytes);
  expect(d.image.width).toBe(451);
  expect(bytes.length).toBeLessThan(fs.statSync(fixture('photo.png')).size / 4);
  expect(errors).toEqual([]);
});

test('lossless preset is bit-exact', async ({ page }) => {
  await page.goto('/compress');
  await page.locator('#smg-preset').selectOption('archive');
  await upload(page, fixture('icon.png'));
  await page.getByTestId('compress-btn').click();
  await expect(page.getByTestId('results')).toContainText('bit-exact', { timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-btn').click()]);
  const smg = decode(await downloadBytes(dl));
  const src = decodePng(new Uint8Array(fs.readFileSync(fixture('icon.png'))));
  expect(pixelsEqual(smg.image, src.image)).toBe(true);
  expect(smg.info.exact).toBe(true);
});

test('target size is honoured', async ({ page }) => {
  await page.goto('/compress');
  await page.locator('#smg-preset').selectOption('photo');
  await page.locator('#smg-target').fill('12');
  await upload(page, fixture('photo.png'));
  await page.getByTestId('compress-btn').click();
  await expect(page.getByTestId('results')).toContainText('met', { timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-btn').click()]);
  const bytes = await downloadBytes(dl);
  expect(bytes.length).toBeLessThanOrEqual(12_000);
});
