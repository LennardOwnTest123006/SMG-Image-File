import { expect, type Page, type Download } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const fixture = (name: string) => path.resolve('e2e/fixtures', name);

/** Collect console errors and uncaught exceptions for a page. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function downloadBytes(d: Download): Promise<Uint8Array> {
  const p = await d.path();
  return new Uint8Array(fs.readFileSync(p!));
}

export async function upload(page: Page, files: string | string[]): Promise<void> {
  await page.locator('[data-testid="file-input"]').first().setInputFiles(files);
}

export function expectSmgSignature(bytes: Uint8Array): void {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x53, 0x4d, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** Path for a scratch file (ASCII-only directory, created on demand). */
export function tmpFile(name: string): string {
  const dir = path.resolve('test-results/tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
