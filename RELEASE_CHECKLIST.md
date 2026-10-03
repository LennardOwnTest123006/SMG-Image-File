# Release checklist

Version being released: **1.0.0** (format 1.0)

## Code & tests

- [ ] `npm ci` succeeds on a clean checkout (Node 22).
- [ ] `npm run typecheck` passes (codec, CLI, web).
- [ ] `npm test` passes (Vitest unit/integration tests).
- [ ] `npm run build` succeeds (codec bundle, CLI bundle, downloads manifest, website).
- [ ] `npm run test:e2e` passes against the production build (converter, compressor, studio, all pages under CSP, mobile layout).
- [ ] The single-file CLI runs outside the repository: `node smg-<version>.mjs encode x.png && node smg-<version>.mjs decode x.smg -o y.png && node smg-<version>.mjs compare x.png y.png` → "Pixels are identical."

## Format & compatibility

- [ ] No bitstream change without a format version bump (see docs/SPEC.md §12). If the bitstream changed, old sample files in `apps/web/public/samples/` were regenerated *and* the change is documented.
- [ ] `docs/SPEC.md` matches the implementation (chunk list, header fields, codec layouts, error codes).
- [ ] Fuzz/corruption tests still pass (container.test.ts).

## Benchmarks & claims

- [ ] `npm run bench` re-run if any codec changed; `bench/results/latest.{json,md}` committed.
- [ ] Every number on the website and in README.md comes from the latest results (the site reads the JSON at build time; README table updated by hand).
- [ ] Limitations section still accurate (where SMG loses).

## Website

- [ ] Version strings updated (`package.json` files, `vite.config.ts` `__APP_VERSION__`, `sw.js` cache name).
- [ ] Lighthouse/visual check of `/`, `/studio`, `/convert`, `/compress` on desktop and phone width.
- [ ] Privacy policy reflects all features (no new network requests).
- [ ] `THIRD_PARTY_LICENSES.md` lists every bundled dependency.

## Deploy

- [ ] Deploy to Netlify (see docs/DEPLOYMENT.md); check the deploy log for errors.
- [ ] Smoke-test the live URL (page loads, PNG → SMG → PNG round trip, downloads, headers).
- [ ] Tag the release: `git tag v1.0.0 && git push --tags`.
- [ ] Update `CHANGELOG.md`.
