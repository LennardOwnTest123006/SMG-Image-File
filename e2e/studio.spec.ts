import { test, expect, type Page } from '@playwright/test';
import { decode } from '../packages/codec/src/index.ts';
import { decodePng } from '../packages/codec/src/io/index.ts';
import fs from 'node:fs';
import { downloadBytes, expectSmgSignature, fixture, tmpFile, trackErrors } from './helpers.ts';

async function openStudio(page: Page) {
  await page.goto('/studio');
  await expect(page.getByTestId('studio')).toBeVisible();
  // Dismiss a recovery prompt left by earlier tests.
  const fresh = page.getByRole('button', { name: 'Start fresh' });
  if (await fresh.isVisible().catch(() => false)) await fresh.click();
}

/** Drag across the viewport between document coordinates (fractions of the canvas). */
async function dragOnCanvas(page: Page, from: [number, number], to: [number, number], steps = 12) {
  const box = (await page.getByTestId('doc-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps });
  await page.mouse.up();
}

async function canvasHash(page: Page): Promise<string> {
  return page.getByTestId('doc-canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
}

test('paints, undoes and redoes', async ({ page }) => {
  const errors = trackErrors(page);
  await openStudio(page);
  const before = await canvasHash(page);
  await page.locator('[data-tool="brush"]').click();
  await dragOnCanvas(page, [0.2, 0.3], [0.7, 0.6]);
  const painted = await canvasHash(page);
  expect(painted).not.toBe(before);
  await page.keyboard.press('Control+z');
  await expect.poll(() => canvasHash(page)).toBe(before);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => canvasHash(page)).toBe(painted);
  expect(errors).toEqual([]);
});

test('creates shapes, text and layers, then exports SMG', async ({ page }) => {
  await openStudio(page);
  await page.locator('[data-tool="rect"]').click();
  await dragOnCanvas(page, [0.1, 0.1], [0.4, 0.5]);
  await expect(page.getByTestId('layer-list')).toContainText('Rectangle');
  await page.locator('[data-tool="ellipse"]').click();
  await dragOnCanvas(page, [0.5, 0.2], [0.8, 0.7]);
  await page.locator('[data-tool="arrow"]').click();
  await dragOnCanvas(page, [0.1, 0.9], [0.9, 0.8]);
  await page.locator('[data-tool="text"]').click();
  const box = (await page.getByTestId('doc-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.75);
  await page.getByTestId('text-content').fill('Hello SMG');
  await expect(page.getByTestId('layer-list')).toContainText('Hello SMG');
  await expect(page.getByTestId('layer-list')).toContainText('Ellipse');
  await expect(page.getByTestId('layer-list')).toContainText('Arrow');

  await page.getByTestId('open-export').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('do-export').click()]);
  const bytes = await downloadBytes(dl);
  expectSmgSignature(bytes);
  const d = decode(bytes);
  expect([d.image.width, d.image.height]).toEqual([1280, 720]);
  await expect(page.getByTestId('export-result')).toContainText(dl.suggestedFilename());
});

test('starts from a template and exports PNG', async ({ page }) => {
  await openStudio(page);
  await page.keyboard.press('Control+n');
  await page.getByRole('radio', { name: 'Templates' }).click();
  await page.getByRole('button', { name: /YouTube thumbnail — bold/ }).click();
  await expect(page.getByTestId('layer-list')).toContainText('NEW VIDEO');
  await page.getByTestId('open-export').click();
  await page.getByRole('dialog').getByRole('radio', { name: 'PNG' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('do-export').click()]);
  const png = decodePng(await downloadBytes(dl));
  expect([png.image.width, png.image.height]).toEqual([1280, 720]);
});

test('imports an image, adjusts it and crops the canvas', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('import-input').setInputFiles(fixture('photo.png'));
  await expect(page.getByTestId('layer-list')).toContainText('photo.png');
  await page.getByTestId('tab-adjust').click();
  const before = await canvasHash(page);
  const slider = page.getByLabel('Brightness');
  await slider.fill('60');
  await expect.poll(() => canvasHash(page)).not.toBe(before);
  await page.getByTestId('apply-adjust').click();
  await page.locator('[data-tool="crop"]').click();
  await dragOnCanvas(page, [0.25, 0.25], [0.75, 0.75]);
  await page.getByTestId('apply-crop').click();
  await expect(page.locator('.studio-status')).toContainText('640×360');
});

test('saves a project file and opens it again', async ({ page }) => {
  await openStudio(page);
  await page.locator('[data-tool="rect"]').click();
  await dragOnCanvas(page, [0.2, 0.2], [0.6, 0.6]);
  await page.locator('[data-tool="brush"]').click();
  await dragOnCanvas(page, [0.1, 0.8], [0.9, 0.9]);
  await page.getByLabel('Document name').fill('Round trip');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  expect(dl.suggestedFilename()).toBe('Round trip.smgp');
  const proj = tmpFile('roundtrip.smgp');
  fs.writeFileSync(proj, await downloadBytes(dl));
  const json = JSON.parse(fs.readFileSync(proj, 'utf8'));
  expect(json.format).toBe('smg-studio-project');
  const expected = await canvasHash(page);
  // Open in a fresh editor.
  await page.keyboard.press('Control+n');
  await page.getByTestId('create-doc').click();
  await expect.poll(() => canvasHash(page)).not.toBe(expected);
  await page.getByTestId('open-input').setInputFiles(proj);
  await expect(page.getByLabel('Document name')).toHaveValue('Round trip');
  await expect.poll(() => canvasHash(page)).toBe(expected);
});

test('recovers autosaved work after a reload', async ({ page }) => {
  await openStudio(page);
  await page.getByLabel('Document name').fill('Recover me');
  await page.locator('[data-tool="ellipse"]').click();
  await dragOnCanvas(page, [0.3, 0.3], [0.6, 0.7]);
  await expect(page.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await page.getByTestId('recover').click();
  await expect(page.getByLabel('Document name')).toHaveValue('Recover me');
  await expect(page.getByTestId('layer-list')).toContainText('Ellipse');
});
