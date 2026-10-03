import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import headers from '../../security-headers.json';

describe('deployment configuration', () => {
  const toml = fs.readFileSync('netlify.toml', 'utf8');
  it('serves the same CSP in production and in local preview', () => {
    const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)?.[1];
    expect(csp).toBe(headers['Content-Security-Policy']);
  });
  it('publishes the web build with SPA fallback', () => {
    expect(toml).toContain('publish = "apps/web/dist"');
    expect(toml).toMatch(/from = "\/\*"\s+to = "\/index.html"\s+status = 200/);
  });
  it('does not allow third-party origins', () => {
    expect(headers['Content-Security-Policy']).not.toMatch(/https?:/);
  });
});
