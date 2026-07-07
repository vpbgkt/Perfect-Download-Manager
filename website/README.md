# Perfect Download Manager — Marketing Website

Static introduction site for [perfectdownloadmanager.com](https://perfectdownloadmanager.com).
No build step, no framework — plain HTML, CSS, and a tiny vanilla JS enhancement. Made to be
hosted on Cloudflare Pages for free.

## Structure

```
website/
├── index.html            Landing page (hero, features, download, extension, FAQ)
├── privacy.html          Privacy policy (mirrors /PRIVACY.md at the repo root)
├── _headers              Cloudflare Pages security + cache headers
├── robots.txt
├── sitemap.xml
└── assets/
    ├── css/styles.css    All styles
    ├── js/main.js        Mobile nav + footer year
    └── img/              Logos, favicons, and the Open Graph social preview
```

## Preview locally

Any static-file server works. Two easy options:

```powershell
# Python (installed on most machines)
python -m http.server 8080 --directory website

# Node (if you have it)
npx --yes serve website -p 8080
```

Open http://localhost:8080 in your browser.

## Deploy to Cloudflare (Workers with Static Assets)

Cloudflare's current unified "Create and deploy" flow (as of 2025) requires a build/deploy
command even for static sites. We handle that with `wrangler.jsonc` at the repo root, which
tells Wrangler that the deployable artefact is the `./website` folder and nothing needs
compiling.

One-time setup (5–10 minutes):

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com).
2. **Workers & Pages → Create → Ship something new → Connect to Git**.
3. Pick the `vpbgkt/Perfect-Download-Manager` repository. Authorise Cloudflare to read it.
4. On the **"Set up your application"** screen, fill:
   - **Project name**: `pdm-website` (matches `name` in `wrangler.jsonc`)
   - **Production branch**: `main`
   - **Root directory**: *(leave empty)*
   - **Build command**: *(leave empty)*
   - **Deploy command**: `npx wrangler deploy`
   - **Non-production branch builds**: on (gives you preview URLs on PRs)
   - **Create new token**: yes (Cloudflare provisions a scoped API token automatically)
5. Click **Save and Deploy**. First deploy takes ~60 seconds. You'll see a
   `pdm-website.<account>.workers.dev` URL to smoke-test.

Bind the custom domain:

6. On the project → **Settings → Domains and Routes → Add custom domain**.
7. Enter `perfectdownloadmanager.com`. Cloudflare wires the DNS records for you because the
   domain is already on your account.
8. Add `www.perfectdownloadmanager.com` too if you want the `www` prefix to redirect to the
   apex.

From now on, every push to `main` that touches `website/` or `wrangler.jsonc` triggers a
fresh deploy. Non-production branches get preview URLs on push.

### Deploying manually from your machine

If you ever want to deploy without going through GitHub:

```powershell
# One-time: install Wrangler globally (or use npx as below).
npm install -g wrangler

# Log in interactively (opens a browser).
npx wrangler login

# Deploy from the repo root.
npx wrangler deploy
```

## Update the download links

The download buttons on the landing page currently point at
`https://github.com/vpbgkt/Perfect-Download-Manager/releases/latest`. That works only if you
publish public releases on GitHub. Alternatives:

- **Direct S3**: replace the `href` with the signed release URL from
  `s3://pdm-updates-<accountid>-aps1/stable/pdm-<version>.zip`. The MSI is not currently
  uploaded to S3 — the release script only ships the update zip. Add a second `aws s3 cp` call
  to `backend/updates/sign-release.ps1` if you want the MSI on S3 too.
- **Cloudflare R2 with a custom subdomain**: set up `download.perfectdownloadmanager.com`
  pointing at an R2 bucket, upload the MSI + zip there, and link to them directly. Zero
  egress fees.

When you settle on one, update the two `<a>` tags with `class="btn btn-block"` inside the
`#download` section of `index.html`.

## Roll a new version

When PDM ships a new build:

1. Update the version string in `index.html` (search for `1.0.10` and replace).
2. Update the file sizes on the download cards.
3. Commit and push. Cloudflare Pages deploys within a minute.

For a longer-lived, professionally designed site (blog, docs, dashboard, checkout), migrate to
Astro or Next.js later — the current v1 covers the introduction/download job with zero build
complexity.
