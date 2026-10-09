# ShareDeals

A Slickdeals-style community deals platform **for India**, built from [prd.md](prd.md). Users post deals from Flipkart, Amazon.in, Myntra, AJIO, Nykaa, Meesho and other retailers by pasting a URL, and the community votes, comments, and saves them. Moderators and Admins keep the catalog clean from a desktop-web **Admin Mode**.

**India localization:**
- **Prices:** in ₹ with Indian digit grouping (₹1,29,999). The full price is labelled **MRP**. Price fields accept `₹`, `Rs.` and lakh-grouped input. Values are stored as integer paise.
- **Duplicate detection:** product links are reduced to their product ID for Flipkart (`itm…` + `pid` variant), Myntra (style ID), Nykaa (product + `skuId` shade), AJIO, Meesho, and Amazon.in (ASIN). This blocks the same product even when it's shared from the app, search results, or an affiliate link. Short links (`fkrt.it`, `amzn.in`, `myntr.it`, `amzn.to`) are followed to the product page first.
- **Store names:** auto-detected for about 25 Indian retailers, including Flipkart, Myntra, AJIO, Nykaa, Meesho, Tata CLiQ, Croma, JioMart, BigBasket and Reliance Digital.
- **Categories:** Mobiles, Electronics, Fashion, Beauty & Personal Care, Home & Kitchen, Grocery, Travel, Gaming, Toys & Kids, Apps & Services, Other.
- **Share previews:** OG tags use `INR` and `en_IN`.

**Stack:** Node ≥ 22.13 and PostgreSQL, with no build step. The only runtime dependency is `pg`. Locally, with no `DATABASE_URL` set, the app runs on an embedded Postgres (PGlite, a dev dependency) stored in `data/pglite/`, so you don't need a database server to develop or test.

```bash
npm install        # pg + PGlite (local Postgres)
npm start          # http://localhost:3000 (auto-seeds demo data on first run)
npm run dev        # same, restarts on file changes
npm test           # unit + API tests on in-memory Postgres (TEST_DATABASE_URL=… to use a real server)
npm run seed       # wipe the database and reseed demo data (refuses when NODE_ENV=production)
```

Demo accounts (password `password123`): `admin` (Admin), `mod_priya` (Moderator), `rahul`, `deal_guru_amit`, `sneha_saves`, … (Users). Seed deals link to real search pages on Flipkart, Amazon.in, Myntra, AJIO, Nykaa and Meesho.

Env vars: `PORT` (3000), `DATABASE_URL` (Postgres; unset = local PGlite), `PG_POOL_MAX` (10), `SEED=0` (never auto-seed demo data), `PUBLIC_URL` (absolute base for share/OG links), `NODE_ENV=production` (Secure cookies, static caching).

**Social sign-in (optional):** set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` and/or `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET`. Each button appears on the sign-in and register pages only when its pair is set. Register these redirect URIs with the provider: `<PUBLIC_URL>/auth/google/callback` and `<PUBLIC_URL>/auth/facebook/callback`. The first social sign-in creates an account, or links to an existing account with the same verified email. Code: `src/oauth.js`.

## What's built (PRD section → where)

| PRD | Feature | Notes |
|---|---|---|
| §6 | Homepage: Latest / 🔥 Hot / For You | Each section is its own horizontal scroller. Deal cards support inline voting. |
| §7 | Listings `/deals` | Newest or Hot sort, category chips, search, infinite scroll |
| §8 | Deal detail `/deals/:id` | Every element 8.1–8.12 |
| §9 | Submission `/submit` | Paste URL → dedup check → server-side auto-populate (JSON-LD `Product` + Open Graph) → review/edit → publish. Falls back to manual entry when scraping fails (§9.1) |
| §9.3 | Browser extension `extension/` | One-click submission (see below) |
| §10 | Duplicate detection | URL canonicalization (tracking params, `www`, scheme, trailing slash, fragment, Amazon `/dp/ASIN`, shortener resolution), SHA-256 hash, **partial unique DB index** so concurrent double-submits can't both win |
| §11 | Voting | One vote per user per deal; clicking the same vote again clears it, clicking the opposite vote switches it |
| §12 | Comments | Public read, sign-in to post, report button, mod removal |
| §13 | Wishlist `/saved` | Removed deals stay visible as "No longer available". Also has a "My posts" tab |
| §14 | Share | Native share sheet (Web Share API) or copy link; server-rendered OG tags on `/deals/:id` for rich unfurls |
| §15 | Admin Mode `/admin` | Report queue, deal/comment removal + restore (soft delete), users (suspend/ban/reinstate, promote/demote), categories, audit log |
| §17 | NFRs | Server-side role checks on every endpoint, per-user rate limits, scrypt passwords, HttpOnly session cookies, CSRF defenses, strict CSP, SSRF-guarded fetcher |

## Decisions on the PRD's open questions

The PRD left these open, so I chose defaults. Each is easy to change:

| # | Question | Decision | Where to change |
|---|---|---|---|
| 1 | Hot formula | `score / (age_hours + 2)^1.5` over a 14-day window (Hacker-News style) | `src/ranking.js` |
| 2 | For You signals and cold start | Per-category affinity: bookmark +3, upvote +2, downvote −2, comment +1, view +0.5, applied to hot-ranked deals. Excludes deals you posted, voted on, or saved. Signed-out or no history → shows Hot, labelled "Trending" | `src/ranking.js` |
| 3 | Pre-publish queue? | No, deals go live immediately | `POST /api/deals` |
| 4 | Is a removed deal's URL re-postable? | **Yes.** Only *active* deals reserve a URL (partial unique index). Restoring a removed deal fails with 409 if its URL has been re-posted | `src/db.js` |
| 5 | Votes/comments on removed deals | Preserved (soft delete), so restoring a deal brings them back | — |
| 6 | Self-votes | **Blocked** (403); the vote buttons are disabled on your own deals | vote route |
| 7 | Can Moderators suspend/ban? | **No, Admin only.** Moderators handle content; Admins handle users and categories | `ADMIN` guards in `src/app.js` |
| 8 | Category list | Seeded with an India-oriented version of the PRD starter set (adds Mobiles). Admins can add, rename, or hide categories | Admin Mode → Categories |
| 9 | Comment reporting | Yes, a "Report" button on each comment feeds the moderation queue | — |

Other choices: suspended users can browse but not post, vote, or comment. Banned users are signed out everywhere and can't sign in. Admins can't modify other Admins and can't create new Admins from the UI. Deal price is required (`0` = FREE) and MRP is optional.

## Browser extension (PRD §9.3)

`extension/` is an unpacked Chrome/Edge MV3 extension. To install it, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the `extension/` folder. Clicking the toolbar button opens `/submit?url=<current tab>` in a popup window. That window runs the same dedup check, auto-populate, and review/edit step as the website, and nothing posts until you confirm. It uses your normal web session. To point it at a non-local deployment, change the site URL in the extension's Options page.

## Not built: native iOS/Android apps (PRD Phase 4)

The web client is responsive and mobile-first, with a bottom tab bar and native share sheet. The native apps should be built against this same JSON API (`/api/*`), so all clients share one backend as the PRD requires. Two things are still needed before that:
- **Token auth for mobile clients.** The API currently uses cookie sessions.
- **Universal/App Links** for deep linking from shared URLs.

## Project layout

```
server.js            HTTP entry point
src/app.js           Router + all API endpoints + SPA/OG rendering
src/db.js            Postgres access (pg / PGlite), schema migrations, transactions
src/canonicalize.js  URL canonicalization for dedup
src/scrape.js        SSRF-safe fetcher + metadata extraction
src/ranking.js       Hot + For You ranking
src/auth.js          Password hashing, sessions
src/seed.js          Demo data
public/              Vanilla-JS single-page app (index.html, app.js, styles.css)
extension/           One-click submission browser extension
test/                node:test suites
```

## Production gaps to address before launch

- Rate limiting is in-memory per process; use Redis or similar when running multiple instances.
- Schema changes go in `MIGRATIONS` in `src/db.js`. They are append-only and applied on boot, under an advisory lock so concurrent instances don't race. Never edit a migration that has shipped.
- Retailer scraping is best-effort. Amazon.in, Flipkart and Myntra often block bots or render prices with JavaScript, and users then see the manual-entry fallback. Per-retailer parsers or affiliate product APIs would improve the auto-fill rate (PRD §19). Examples are Amazon PA-API and the Flipkart Affiliate API.
- Users can't yet reset passwords, verify email, or report other user accounts.

## Deploying on Railway

1. Create a project with a **PostgreSQL** service and a service for this repo. In the app service's variables, reference the database: `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Set `NODE_ENV=production`, `SEED=0`, `PUBLIC_URL=https://sharedeals.in`, and the optional social sign-in keys.
3. The build runs `npm install` and the start command is `npm start` (Railway detects both). Tables are created on first boot. To create them by hand instead, run `npm run migrate`. It is safe to run any number of times and never deletes data.
   - **Data wiped on every deploy?** Then the app isn't connected to the Postgres service. Without `DATABASE_URL` it would store data on the container's disk, which each deploy replaces. The server now refuses to start on Railway without `DATABASE_URL`, so this fails loudly instead of losing data.
4. Add the custom domain `sharedeals.in` in the service's Networking settings, then create the DNS record Railway shows you.
