# DealShare

A Slickdeals-style community deals platform built from [prd.md](prd.md). Users post deals by pasting a URL, and the community votes, comments, and saves them. Moderators and Admins keep the catalog clean from a desktop-web **Admin Mode**.

**Zero dependencies.** Node ≥ 22.13 only (uses the built-in `node:sqlite`). No `npm install`, no build step.

```bash
npm start          # http://localhost:3000 (auto-seeds demo data on first run)
npm run dev        # same, restarts on file changes
npm test           # 28 unit + API integration tests
npm run seed       # wipe data/deals.db and reseed
```

Demo accounts (password `password123`): `admin` (Admin), `mod_maya` (Moderator), `alice`, `bargainbob`, … (Users).

Env vars: `PORT` (3000), `DB_FILE` (`data/deals.db`), `PUBLIC_URL` (absolute base for share/OG links), `NODE_ENV=production` (Secure cookies, static caching).

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
| 8 | Category list | Seeded with the PRD starter set. Admins can add, rename, or hide categories | Admin Mode → Categories |
| 9 | Comment reporting | Yes, a "Report" button on each comment feeds the moderation queue | — |

Other choices: suspended users can browse but not post, vote, or comment. Banned users are signed out everywhere and can't sign in. Admins can't modify other Admins and can't create new Admins from the UI. Deal price is required (`0` = FREE) and full price is optional.

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
src/db.js            SQLite schema (users, deals, votes, comments, bookmarks, views, reports, moderation_actions)
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
- SQLite fits a single node. Move to Postgres for multi-instance deployment (the schema ports directly).
- Retailer scraping is best-effort. Amazon and other large retailers often block bots, and users then see the manual-entry fallback. Per-retailer parsers or a product API would improve the auto-fill rate (PRD §19).
- Users can't yet reset passwords, verify email, or report other user accounts.
