# Deploying the SMG website

The website is a static single-page application. Everything (decoding, editing, encoding) runs in the visitor's browser, so no server-side code, database, secrets or environment variables are needed.

## Netlify (recommended)

`netlify.toml` contains the complete configuration:

| Setting | Value |
|---------|-------|
| Build command | `npm run build` (builds `@smg/codec`, `@smg/cli`, prepares `/downloads`, then the site) |
| Publish directory | `apps/web/dist` |
| Node version | 22 (`NODE_VERSION`) |
| Redirects | `/*` → `/index.html` (200) for client-side routing |
| Headers | strict CSP (no third-party origins), `nosniff`, `DENY` framing, HSTS, long-lived immutable caching for `/assets/*`, `no-cache` for `index.html` and `sw.js`, `image/x-smg` content type |

### Option A — connect the Git repository

1. In Netlify: **Add new site → Import an existing project → GitHub** and pick this repository.
2. Netlify reads `netlify.toml`; keep the detected build command and publish directory.
3. Deploy. Every push to the production branch redeploys; pull requests get deploy previews.

### Option B — deploy a local build with the Netlify CLI

```bash
npm install
npm run build
npx netlify-cli deploy --dir=apps/web/dist            # draft URL for checking
npx netlify-cli deploy --dir=apps/web/dist --prod     # production
```

The CLI asks you to log in and to link or create a site the first time.

## Other static hosts

Any static host works if it (1) serves `apps/web/dist`, (2) rewrites unknown paths to `/index.html`, and ideally (3) sends the headers from `netlify.toml`. The same CSP is used by `vite preview` (`apps/web/security-headers.json`), and a unit test keeps both in sync.

## Verifying a deployment

1. Open `/`, `/studio`, `/convert`, `/compress`, `/format`, `/benchmarks`, `/docs`, `/download`, `/privacy`, `/about` — no console errors.
2. Convert a PNG to SMG and back on `/convert`; the round trip should be bit-exact for lossless presets.
3. `/download` lists the release files; `curl -sI https://<site>/downloads/manifest.json` returns 200.
4. Response headers include `content-security-policy` and `x-content-type-options: nosniff`.

You can also run the end-to-end suite against any URL by changing `baseURL` in `playwright.config.ts`.
