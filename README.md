# ClipFinder — React + Tailwind

A React/Vite migration of the ClipFinder COD Mobile clip-finding website. The browser-side detection modules and worker pipeline are carried over from the original site; the interface is now composed of React components and styled with Tailwind CSS.

## Requirements

- Node.js 20.19+ or 22.12+ (Node.js 22 LTS recommended)
- npm
- A modern browser with WebCodecs (`VideoDecoder`) and `OffscreenCanvas`

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Localhost is treated as a secure context by modern browsers, which is required for the scanner APIs.

## Production build

```bash
npm run build
npm run preview
```

The deployable site is written to `dist/`.

## Cloudflare Workers (matches the existing `workers.dev` hosting)

This project includes `wrangler.jsonc` with `dist/` as the static asset directory and SPA fallback enabled.

```bash
npm run deploy       # build, then deploy to Cloudflare Workers
```

Wrangler will prompt you to authenticate with Cloudflare the first time. The Worker is named `clipfinder`; change `name` in `wrangler.jsonc` if you want a different Worker. The SPA fallback serves React routes such as `/contact`, `/privacy`, and `/terms` from `index.html`.

### Cloudflare Pages alternative

- Build command: `npm run build`
- Build output directory: `dist`
- The `public/_redirects` file provides SPA route fallback for `/contact`, `/privacy`, and `/terms`.

## Project structure

```text
public/
  _redirects
  hud-profile.json
  live-profile.json
  assets/
    combo_word.bin
    digits.bin
src/
  components/       Reusable interface components
  engine/           Original browser detection and worker pipeline
  pages/             Home, Contact, Privacy, Terms
  App.jsx
  index.css
  main.jsx
  useClipFinder.js   React state and worker orchestration
```

## Scanner notes

- Replay and Live Match recording modes are preserved.
- The original HUD templates and binary digit/word assets are required and included under `public/`.
- Video reading and clip cutting use the `mediabunny` npm package.
- Download All uses the `jszip` npm package.
- Scanning runs in browser workers; recordings are processed locally and are not uploaded by this application.
- The browser must support `VideoDecoder` and `OffscreenCanvas`. Use a recent Chrome or Edge over HTTPS for best compatibility.

## Community links

- GitHub: set in `src/components/CommunityCards.jsx` and currently points to the existing ClipFinder repository.
- Suggestions: opens an email draft to the contact address from the original Contact page.
- Patreon: add the creator page URL to `PATREON_URL` in `src/components/CommunityCards.jsx`. The card is visible but its CTA remains disabled until that URL is configured.

## Important

The React migration preserves the original browser scanner modules rather than translating the Python CLI into a server-side API. The Python command-line scanner is a separate tool and is not required to run this website.


## Security and resource safeguards

- The development server allows only Vite's normal local hosts by default. For a temporary Cloudflare Quick Tunnel, set `CLIPFINDER_DEV_ALLOWED_HOSTS` to the exact current hostname before starting Vite. Do not use `allowedHosts: true` or a wildcard. In PowerShell:

  ```powershell
  $env:CLIPFINDER_DEV_ALLOWED_HOSTS = "your-random-name.trycloudflare.com"
  npm run dev
  ```

  The Vite development server is not a production host. Keep a Quick Tunnel open only for controlled testing, share it only with trusted testers, and stop `cloudflared` when finished.

- The `?parts=` worker debugging override is honoured only in development and is limited to 1–4 workers. The worker independently clamps the requested count. Automatic scan and analysis pools are also capped.
- Recordings are limited to 4 GiB, two hours, and roughly 4K pixel dimensions. These checks are repeated inside the scanner before decoding/packet analysis.
- Clip cutting has per-clip and per-scan output-memory limits. Batch ZIP/share generation is limited to 256 MiB; larger batches should be downloaded clip by clip.
- Generated clip and archive names are sanitized before download.
- `public/_headers` applies production browser security headers (including an enforced Content Security Policy) when deployed through Cloudflare Workers Static Assets or Cloudflare Pages. Verify the headers against the deployed response after deployment, especially if you later add third-party scripts, fonts, analytics, or embedded content.
- The Privacy Policy describes local video processing and hosting-provider request metadata. Update it if analytics, cookies, APIs, or other external processing are introduced.

Run `npm install` to create/update `package-lock.json`, commit that lockfile, then use `npm ci` for repeatable installs. Review `npm audit` output before upgrading dependencies; do not force major-version upgrades automatically.
