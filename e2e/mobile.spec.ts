import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const path of ['/', '/studio', '/convert', '/compress', '/format', '/benchmarks', '/docs', '/download', '/privacy', '/about']) {
  test(`no horizontal overflow on ${path} at phone width`, async ({ page }) => {
    await page.goto(path);
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('mobile navigation menu opens', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Convert' }).click();
  await expect(page).toHaveURL(/\/convert$/);
});

test('studio paints with touch on a phone', async ({ page }) => {
  await page.goto('/studio');
  const fresh = page.getByRole('button', { name: 'Start fresh' });
  if (await fresh.isVisible().catch(() => false)) await fresh.click();
  const before = await page.getByTestId('doc-canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const box = (await page.getByTestId('viewport').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.getByTestId('viewport').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: cx - 40, clientY: cy, button: 0, isPrimary: true });
  for (let i = 0; i <= 10; i++) await page.getByTestId('viewport').dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: cx - 40 + i * 8, clientY: cy + i * 3, isPrimary: true });
  await page.getByTestId('viewport').dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: cx + 40, clientY: cy + 30, isPrimary: true });
  await expect.poll(() => page.getByTestId('doc-canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(before);
});
