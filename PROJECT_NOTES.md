# ShareDeals.in: project notes

How this project is set up and why. It covers the decisions, how things are wired, and the gotchas that the code alone doesn't make obvious. Read it before changing deployment, the database, sign-in, or the posting flow. For the feature list and the PRD mapping, see [README.md](README.md). For the original requirements, see [prd.md](prd.md).

**Never put passwords, API keys or `DATABASE_URL` values in this file or anywhere else in the repo.** Secrets live only in Railway's service variables.

---

## 1. What it is

**ShareDeals.in** (domain: `sharedeals.in`) is a community deals site for **India only**. It's like Slickdeals: users post deals from Indian stores, and the community votes, comments, saves and shares them. Moderators and admins keep it clean from **Admin Mode** (`/admin`).

- **Prices:** shown in ₹ with Indian grouping (₹1,29,999). The full price is called **MRP**. Prices are stored as integer paise.
- **One deal per product:** a deal is a *product* ("Google Pixel 10a 256 GB"). Each store's link is an **offer** on that deal, so a deal can list Amazon, Flipkart and Croma side by side. The headline price is the cheapest active offer.
- **Approved stores only:** see §6.

## 2. Stack

| Part | Choice |
|---|---|
| Server | Node ≥ 22.13, plain `node:http` with its own small router (`src/http.js`). No framework, no build step. |
| Database | **PostgreSQL**. Production uses the `pg` driver with `DATABASE_URL`. Local dev and tests use **PGlite** (Postgres compiled to WASM, in-process, data in `data/pglite/`). |
| Front end | Vanilla JS single-page app, `public/app.js` (the one the site loads), plus `public/styles.css`. |
| Hosting | **Railway**: an app service plus a PostgreSQL service. GitHub repo `bare894/deals`. |
| Analytics | Google Analytics 4, `G-BSMZRCKB6Y` (§10). |
| Extension | Chrome/Edge MV3 in `extension/` (§9). |

Dependencies: `pg` is the only runtime dependency, and `@electric-sql/pglite` is a dev dependency. **No `package-lock.json` is committed yet.** Run `npm install` on a normal network and commit the lock file it creates.

## 3. Layout

```
server.js               boot: open DB (+ migrations), optional demo seed, HTTP server, graceful SIGTERM
src/app.js              request handling: API router, /auth/* (OAuth), static files, SPA fallback,
                        server-rendered Open Graph tags on /deals/:id, security headers (CSP)
src/db.js               Postgres access layer, MIGRATIONS list, tx()/savepoint(), categories
src/repo.js             deals/offers data access: listings, ranking, matching, merge, remove/restore
src/routes/*.js         auth, deals, offers, admin, health, common (validation, approved stores)
src/oauth.js            Google + Facebook sign-in (server-side OAuth code flow)
src/scrape.js           page fetching (SSRF-guarded) and field extraction (title, image, price, MRP, category)
src/canonicalize.js     URL canonicalization + product-ID extraction for dedup
src/matching.js         "same product?" scoring across stores
src/ranking.js          Hot and For You ranking formulas
src/seed.js             demo data (India). npm run seed wipes and reseeds
src/make-admin.js       create or promote an admin (npm run make-admin)
src/migrate.js          apply migrations without starting the server (npm run migrate)
public/app.js           the web client (the one index.html loads)
public/js/              UNFINISHED split-up rewrite of the client, not loaded by the site (§13)
public/analytics.js     GA4 loader
extension/              browser extension
brand/logo-source.png   original logo artwork (kept out of public/, 1.1 MB)
test/                   node:test suites: units, API, OAuth
```

## 4. Running locally

```bash
npm install          # pg + PGlite
npm start            # http://localhost:3000. Embedded Postgres in data/pglite/; seeds demo data on first run
npm run dev          # same, restarts on file changes
npm test             # in-memory Postgres; TEST_DATABASE_URL=postgres://… runs against a real server (wipes it)
npm run seed         # wipe + reseed the database (refuses when NODE_ENV=production)
npm run migrate      # create/update tables only
npm run make-admin -- --email you@example.com --handle yourname [--password '…']
```

- **Demo accounts** (local only, password `password123`): `admin`, `mod_priya`, `rahul`, `deal_guru_amit`, `sneha_saves` and others. The "Demo accounts" hint on the sign-in page is hidden when `NODE_ENV=production`.
- **One process at a time:** PGlite allows only one process to open `data/pglite/`. Stop the server before running `npm run make-admin`, `seed` or `migrate` locally.
- **Old file:** `data/deals.db*` is left over from the SQLite days and is unused. `data/` is git-ignored.

## 5. Deployment (Railway)

1. **Add a PostgreSQL service** to the project. It keeps its data across app deploys.
2. **Set variables on the app service:**

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Connects to the Postgres service. **Required.** |
| `NODE_ENV` | `production` | Secure cookies, static caching, hides the demo hint, blocks `npm run seed` |
| `SEED` | `0` | Never load demo accounts or fake deals into production |
| `TRUST_PROXY` | `1` | Read the visitor IP from Railway's proxy (rate limits) |
| `PUBLIC_URL` | `https://sharedeals.in` | Absolute links in share previews and OAuth redirect URIs |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud | Optional; shows "Continue with Google" |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | from Meta for Developers | Optional; shows "Continue with Facebook" |
| `PG_POOL_MAX` | default `10` | Pool size |

3. **Build and start:** Railway detects `npm install` and `npm start`. Tables are created on first boot.
4. **Health check:** set the Healthcheck Path to `/api/health`. It returns 503 if the database is unreachable, so a broken deploy never takes traffic.
5. **Domain:** add `sharedeals.in` under the app service's Networking settings and create the DNS record Railway shows.
6. **First admin:** open a shell on the app service (`railway ssh`) and run `npm run make-admin -- --email … --handle …`. It prints a random password once. If the email matches your Google account, "Continue with Google" signs into the same admin account.

**History: data was wiped on every deploy.** The app had no `DATABASE_URL`, so it fell back to PGlite on the container's disk, which Railway replaces on each deploy. The server now **refuses to start** on Railway, or with `NODE_ENV=production`, without `DATABASE_URL`.

**To check the deployment,** open `https://sharedeals.in/api/health`:
- Everyone sees `{"ok":true,"database":"postgres",…}`. If it says `pglite`, data won't survive a deploy.
- Signed in as an admin, you also see the database name and version, schema version, row counts, which variables are set (never their values), and the deployed commit.

## 6. Posting rules

- **Approved stores only:** Amazon.in, Flipkart, Meesho, Snapdeal, Myntra, Tata CLiQ, AJIO, JioMart, Croma and Nykaa. The list is `APPROVED_STORES` in `src/routes/common.js`.
  - It's checked server-side for auto-fill, new deals and adding a store to a deal, so it covers the website, the extension and the API alike.
  - Matching uses the registrable domain, so subdomains like `dl.flipkart.com` are fine and look-alikes are refused.
  - Short links (`amzn.in`, `fkrt.it`, `bit.ly` …) are followed and judged by where they lead.
  - Other sites are refused **before** anything is fetched from them.
  - Existing deals are not affected.
- **Exact-link dedup:** URLs are canonicalized (tracking parameters removed; Amazon ASIN, Flipkart `itm`+`pid`, Myntra style ID and so on), and the canonical form is hashed. A partial unique index means only one *active* offer per link. Removed deals free their links.
- **Same product from another store:** `findMatches` scores title, GTIN and MPN similarity.
  - If it's very likely the same product, the client shows **"This product is already on ShareDeals"** and offers **Add my ⟨store⟩ link to this deal** (`POST /api/deals/:id/offers`) or **post a new deal** (`confirmNew: true`).
  - The server enforces this too: creating a deal without `confirmNew` returns 409 with `matches`.
- **One offer per store per deal.** Offers keep the poster's exact URL, so their affiliate tag survives.
- **Self-votes** aren't allowed. Clicking the same vote again clears it.

## 7. Auto-fill (scraping)

`src/scrape.js`:
- `safeFetch` blocks private and internal addresses (SSRF), caps size and limits redirects.
- `extractDealFields(html, url)` returns `{title, imageUrl, price, fullPrice (MRP), store, category, gtin, mpn}`.

| Field | Where it comes from |
|---|---|
| Title, image, price | JSON-LD `Product`, Open Graph and product meta tags. **Amazon.in has no JSON-LD**, so for Amazon: `#productTitle`, `#landingImage` (`data-old-hires`), and `a-price-whole` in the `priceToPay` box. |
| MRP (`findMrp`) | 1) visible `M.R.P.`/`MRP` label next to a ₹ amount; 2) Amazon's struck-through price; 3) embedded app-state keys (`"mrp"`, `"listPrice"`, `"originalPrice"`…), which is where Flipkart and Myntra keep it. Accepted only if it's above the price and at most 20× it (rejects "-₹8,000 off" labels and other products' prices). The regex is written to stay fast on multi-MB pages; a test enforces this. |
| Category (`guessCategory`) | JSON-LD `BreadcrumbList`, Amazon's breadcrumbs, and `Product.category` (Flipkart: `"mobile"`). The most specific crumb wins, then the title, mapped onto the site categories. The prefill route turns the name into a category ID. |

**Verified** on real Pixel 10a pages (Oct 2026):
- Amazon: ₹51,430, MRP ₹55,999, Mobiles
- Flipkart: ₹47,999, MRP ₹55,999, Mobiles

**Server fetches get blocked:** stores, Amazon especially, often send bot checks to cloud servers such as Railway, so the server's fetch can come back empty. The **extension** gets around this (§9). On the website, the form falls back to manual entry.

## 8. Accounts and sign-in

- **Passwords:** hashed with scrypt. Sessions use an HttpOnly cookie `sid` (SameSite=Lax; Secure in production), valid for 30 days and stored in `sessions`.
- **Roles:** `user`, `moderator` and `admin`.
  - Admin Mode can promote users to moderator, but **cannot create admins**. Use `npm run make-admin`.
  - User management and categories are admin-only.
- **Google and Facebook** (`src/oauth.js`): server-side code flow, with a CSRF `state` cookie and a safe `next` redirect.
  - A button shows only when both of that provider's variables are set.
  - Redirect URIs to register: `<PUBLIC_URL>/auth/google/callback` and `<PUBLIC_URL>/auth/facebook/callback`.
  - **First sign-in:** creates an account with a handle taken from the name, or links to an existing account with the same **verified** email.
  - **Later sign-ins** are matched on the provider's user ID (`oauth_identities`), so they still work if the email changes.
  - Social-only accounts have no password.
  - **Going live:** the Google consent screen must be set to "In production", and the Facebook app must be **Live**, with a privacy-policy URL and a data-deletion URL.
- **Rate limits** live in memory, per process. They're keyed by user, or by IP for sign-in and registration. With more than one replica, each replica counts separately.

## 9. Browser extension (`extension/`, v1.1.1)

- **Install:** `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
- **Default site:** `https://sharedeals.in` (changeable on the Options page).
- **Flow:** the toolbar click opens a popup at `/submit?url=<tab>&via=extension`.
  - The popup *is* the website, so it uses the normal session. If you're signed out, the sign-in page appears and then returns with the link kept.
  - Duplicate checks, review and edit all work as on the site. Nothing posts until the user confirms.
- **Page details:** `snapshotPage()` runs in the store tab (via `activeTab` + `scripting`) and collects:
  - meta tags and JSON-LD
  - Amazon's buy box and breadcrumbs
  - visible MRP labels
  - the text around price keys in embedded app state

  That's about 10–40 KB. The background script posts it into the popup with `window.postMessage`, and the page sends it with `/api/deals/prefill` as `html`. The server extracts from that first and only fetches to fill gaps; this route accepts bodies up to 1 MB.
- **`host_permissions`** must include the site's address for the hand-off to work: sharedeals.in, `*.up.railway.app` and localhost are listed. For any other address the extension still works, but the server has to fetch the page itself.
- **Tested** by running `snapshotPage()` in headless Chrome on the real Amazon and Flipkart pages; both filled in fully with no server fetch. Not yet click-tested as an installed extension.

## 10. Analytics (GA4)

- **Loading:** `public/analytics.js` loads gtag.js. Inline scripts are blocked by the CSP, which allows `googletagmanager.com` and `*.google-analytics.com`. Nothing is sent from localhost.
- **Page views:** the site sends `page_view` itself after each page renders, because navigation happens without full page loads (`send_page_view: false` on config).
  - **Required GA setting:** Admin → Data streams → Enhanced measurement → **turn off "Page changes based on browser history events"**, or page views get counted twice.
- **Events:**
  - `get_deal` (deal_id, store, link_url)
  - `post_deal`
  - `add_store_link`
  - `sign_up` / `login` (method `email`)
  - `vote`
  - `add_to_wishlist`
  - `share`
- **Not tracked yet:** Google and Facebook sign-ins.

## 11. Brand

- **Logo:** cart artwork with "share₹e deals.in". Generated assets:
  - `public/img/logo.png` and `logo-dark.png` (navy turned white for dark mode)
  - `mark.png` and `mark-dark.png` (cart only, used on narrow screens)
  - `og-image.png` (1200×630)
  - favicons and `apple-touch-icon.png`
  - extension icons `extension/icon{16,32,48,128}.png`: the logo mark on a white rounded tile, so it shows on light and dark toolbars. 48 and 128 px include the navy speed lines; 16 and 32 px show the cart only.
- **Palette** (CSS variables in `styles.css`):
  - `--brand-pink: #EC0276`, used for primary buttons and the accent
  - `--brand-navy: #010A5E`, used for the second brand colour and downvotes
  - In dark mode, buttons keep `#EC0276`, and pink text uses `--accent-text: #FF5AA5` so it stays readable.
- **Name:** "ShareDeals" in copy, "ShareDeals.in" in titles and the logo.

## 12. Database

- **Schema:** the `MIGRATIONS` array in `src/db.js`. It's append-only and applied on boot inside a transaction with an advisory lock (safe with several replicas), and recorded in `schema_migrations`. **Never edit a shipped migration; add a new one.** The current version is 1.
- **Data types:**
  - Timestamps are epoch milliseconds in `BIGINT`, and prices are paise in `BIGINT`.
  - `pg` and PGlite are both configured to return `BIGINT` as JS numbers.
  - Emails, handles and category names are unique case-insensitively (`lower(...)` indexes).
- **Query helpers:** `db.get`, `db.all` and `db.run` take `?` placeholders, which become `$n`.
- **Transactions:** `tx(db, fn)` uses AsyncLocalStorage, so nested calls join the outer transaction.
- **Expected-error savepoints:** use `db.savepoint()` around statements that may hit an expected unique violation inside a transaction. In Postgres, an error otherwise aborts the whole transaction.
- **Concurrency:** votes, adding offers, offer status changes, restores and merges lock the affected deal row (`FOR UPDATE`; merges lock both rows in ID order).

## 13. Known issues and backlog

- **Failing test:** `deal pages render escaped Open Graph tags`. The test expects `₹19.99 (MRP …) on Shop`, but the code renders `₹19.99 on Shop (MRP …)`. Fix the test or the wording.
- **`public/js/` is an unfinished split-up rewrite of the client.** It has no admin pages and no boot code, and isn't loaded. Either finish it and switch `index.html` over, or delete it. Until then, **client changes go in `public/app.js`**.
- **No `package-lock.json`:** see §2.
- **Unfinished launch checklist:** privacy policy page (DPDP Act 2023; must mention GA cookies), data-deletion page (needed for Facebook), and an affiliate disclosure if affiliate links are used.
- **Not yet built:** password reset and email verification.
- **Not yet built:** tracking Google and Facebook sign-ins as GA events.
- **Rate limits** are in memory, per replica (§8).
- **Dev environment quirk:** on the original development machine, Node couldn't reach the internet (curl and Python could). npm installs were done by a script that downloads registry tarballs and checks their integrity. This doesn't affect Railway.
