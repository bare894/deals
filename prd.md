# Deal-Sharing Community Platform

**Product Requirements Document**

A Slickdeals-style marketplace where users post, discover, vote on, and discuss time-sensitive deals — with community moderation and personalized discovery. Consumers use native iOS and Android apps (plus web); Admins/Moderators moderate from a desktop web Admin Mode.

| | |
|---|---|
| **Status** | Draft — v1.0 |
| **Document Owner** | *TBD* |
| **Engineering Lead** | *TBD* |
| **Target Release** | *TBD* |
| **Last Updated** | Oct 7, 2026 |

## Contents

1. [Overview & Problem Statement](#1-overview--problem-statement)
2. [Goals & Success Metrics](#2-goals--success-metrics)
3. [Roles & Permissions](#3-roles--permissions)
4. [Platform Strategy](#4-platform-strategy)
5. [User Stories](#5-user-stories)
6. [Homepage](#6-homepage)
7. [Listings Page](#7-listings-page)
8. [Deal Detail Page](#8-deal-detail-page)
9. [Deal Submission Flow](#9-deal-submission-flow)
10. [Duplicate Detection](#10-duplicate-detection)
11. [Voting (Upvote / Downvote)](#11-voting-upvote--downvote)
12. [Comments](#12-comments)
13. [Bookmarks / Wishlist](#13-bookmarks--wishlist)
14. [Share](#14-share)
15. [Admin & Moderator Panel](#15-admin--moderator-panel-admin-mode)
16. [Data Model](#16-data-model-high-level)
17. [Non-Functional Requirements](#17-non-functional-requirements)
18. [Out of Scope](#18-out-of-scope-v1)
19. [Risks & Mitigations](#19-risks--mitigations)
20. [Open Questions](#20-open-questions)
21. [Phasing](#21-phasing-proposed)

---

## 1. Overview & Problem Statement

Shoppers waste time hunting across retailer sites for discounts and have no reliable, community-vetted place to find, validate, and share deals in real time. Existing social channels (group chats, forums) lack structure: no dedup, no voting signal, no personalization, and no moderation against spam or expired/fake deals.

We will build a community-driven deals platform where any signed-in user can submit a deal by pasting a URL, the community upvotes/downvotes and discusses deals in comments, and a lightweight moderation layer (Moderators + Admins) keeps the catalog clean. Discovery is surfaced three ways on the homepage: newest, hottest (most upvoted), and personalized ("For You").

> **Primary user outcome:** find a legitimately good, currently-valid deal faster than searching retailer sites or social media, with visible community trust signals (votes, comments).

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|---|---|---|
| Drive deal discovery | Weekly active users viewing a deal detail page | *TBD — needs baseline* |
| Community engagement | % of deal views resulting in a vote or comment | *TBD* |
| Submission quality | % of submitted deals removed by moderators | *TBD, directionally <5%* |
| Submission volume | Deals posted per day | *TBD* |
| Retention | Return visits via bookmarked/wishlisted deals | *TBD* |

> **Note:** No target numbers were provided in the source request. All targets above are placeholders pending input from the business owner — do not treat them as committed goals.

## 3. Roles & Permissions

Three roles. Permissions must be enforced **server-side** on every mutating endpoint — hiding admin UI controls on the client is not sufficient access control.

| Capability | User | Moderator | Admin |
|---|---|---|---|
| Browse deals, vote, comment, share, bookmark | ✓ | ✓ | ✓ |
| Submit a new deal | ✓ | ✓ | ✓ |
| Edit own deal submission | ✓ | ✓ | ✓ |
| Delete any deal post | ✗ | ✓ | ✓ |
| Remove / hide a comment | ✗ | ✓ | ✓ |
| Access Admin Mode (desktop web only) | ✗ | ✓ | ✓ |
| Suspend / ban a user account | ✗ | *TBD* | ✓ |
| Promote a User to Moderator | ✗ | ✗ | ✓ |
| Demote a Moderator to User | ✗ | ✗ | ✓ |
| Manage category list | ✗ | *TBD* | ✓ |

**Platform access:** Admins and Moderators perform all moderation and user-management actions in an **Admin Mode** within the standard desktop web (dweb) app — no separate native admin app or standalone admin tool is required. See §4 for the full breakdown of which surfaces (iOS, Android, desktop web) each role uses.

## 4. Platform Strategy

This product spans four client surfaces with different audiences:

| Surface | Audience | Scope |
|---|---|---|
| **iOS app (native)** | Consumers (Users) | Full consumer experience: Homepage (Latest/Hot/For You), Listings, Deal Detail, voting, comments, bookmarks/wishlist, share, deal submission. |
| **Android app (native)** | Consumers (Users) | Same full consumer experience as iOS, at feature parity. |
| **Desktop web (dweb)** | Consumers, Moderators, Admins | Full consumer experience *plus* Admin Mode (§15) for Moderators/Admins. Consumer features are also available responsively on mobile web, but mobile web is not a substitute for the native apps. |
| **Browser extension** | Consumers (Users) | One-click deal submission only (§9.3) — pre-fills and posts via the same submission/dedup pipeline as web. Not a full browsing surface. |

- **Consumer features (browse, vote, comment, bookmark, share, submit a deal) must exist on iOS, Android, and web.** These are not web-only.
- **Admin Mode (user/role management, deal and comment moderation) is desktop-web-only.** It is not built into the iOS or Android apps, and no separate standalone admin application is required.
- **The browser extension is scoped to one-click submission only** — it is a lightweight capture tool, not an alternate full client, and does not carry browsing/voting/comments functionality.
- All surfaces talk to the same backend/API so voting, comments, bookmarks, submissions, and moderation state stay consistent regardless of which client a user is on.
- Native framework choice (fully native Swift/Kotlin vs. a cross-platform framework like React Native/Flutter) is *TBD* — see Open Questions.

## 5. User Stories

| ID | As a… | I want to… | So that… |
|---|---|---|---|
| US-1 | Visitor/User | see deals sorted newest-first on a listings page | I can quickly scan what's fresh |
| US-2 | User | open a deal and see its image, price, discount, and details | I can judge if it's worth buying |
| US-2b | User | upvote or downvote a deal | I can signal deal quality to others |
| US-3 | Signed-in user | comment on a deal | I can ask questions or share experience |
| US-4 | Signed-in user | bookmark a deal to my wishlist | I can find it again later |
| US-5 | User | share a deal link outside the app | I can tell friends/family |
| US-6 | User | see a "Hot Deals" section ranked by upvotes | I can find the most community-validated deals |
| US-7 | User | see a "For You" section | I see deals relevant to my interests |
| US-8 | Signed-in user | submit a deal by pasting a URL | I don't have to manually fill every field |
| US-9 | Signed-in user | edit auto-populated fields before posting | I can correct inaccurate scraped data |
| US-10 | User | be blocked from posting a URL that's already listed | the catalog doesn't fill with duplicates |
| US-11 | Moderator | delete a spam/expired deal post | the catalog stays clean |
| US-12 | Admin | promote a trusted user to Moderator | I can scale moderation capacity |
| US-13 | Admin | control who can use the platform | I can remove bad actors |
| US-14 | User | browse, vote, comment, bookmark, and submit deals from a native iOS or Android app | I can use the platform on the go without a mobile browser |
| US-15 | Moderator/Admin | moderate deals and users from a desktop browser | I don't need to install a separate admin app |
| US-16 | Signed-in user | submit the product page I'm currently viewing via a one-click browser extension | I don't have to copy/paste the URL into the site to post a deal |

## 6. Homepage

The home screen (web homepage, iOS/Android home tab) is split into three independently-scrollable/paginated sections:

| Section | Sort basis | Notes |
|---|---|---|
| **Latest** | `created_at` descending | Same ordering as the full Listings page; this is a preview slice (e.g., top N). |
| **Hot Deals** | Net score (upvotes − downvotes), with time-decay weighting | Prevents old deals with high historical votes from permanently dominating. Exact decay formula: *TBD* (see Open Questions). |
| **For You** | Personalization model using category affinity, vote/bookmark history, viewed deals | Requires a logged-in user. Signed-out behavior: *TBD* — fall back to Hot or Latest (see Open Questions). |

Each deal card (in all three sections) shows: thumbnail image, title, store, discounted price, full price (struck through), net vote score, comment count, and quick-access upvote/downvote controls (no need to open the detail page to vote).

## 7. Listings Page

- Full, paginated/infinite-scroll feed of all active deal posts. Available on web, iOS, and Android.
- Default sort: newest posted first (`created_at desc`).
- Each row/card is clickable and routes to the Deal Detail page (`/deals/:dealId` on web; equivalent native screen on mobile).
- Filter by category (uses the same predefined category list as submission). Additional filters (store, price range) are *nice-to-have, not in v1 scope unless added*.
- Deals removed by a moderator are excluded from this feed (see §10/§15 for soft-delete behavior).

## 8. Deal Detail Page

Route: `/deals/:dealId` on web; equivalent native screen on iOS/Android. Required elements:

| # | Element | Behavior |
|---|---|---|
| 8.1 | Product image | Displays the image captured at submission (auto-pulled or user-replaced). |
| 8.2 | Item title | Displays submitted/edited title. |
| 8.3 | Full price | Original/list price, shown struck-through. |
| 8.4 | Discounted price | Deal price, shown prominently; discount % computed and displayed. |
| 8.5 | Upvote / downvote buttons | One vote per signed-in user per deal; toggling/changing vote supported (see §11). |
| 8.6 | Deal details | Free-text description entered by poster (terms, coupon code, expiration, shipping notes, etc.). |
| 8.7 | Comments section | Public (readable by anyone, signed-in or not); posting requires sign-in (see §12). |
| 8.8 | Bookmark / Save button | Adds deal to the signed-in user's Wishlist; requires sign-in (see §13). |
| 8.9 | Share button | Generates/copies an external shareable link (see §14). |
| 8.10 | Store / retailer link | Outbound link to the original deal URL, opens in the device browser / new tab. |
| 8.11 | Category badge | Shows the deal's assigned category. |
| 8.12 | Poster attribution | Username/handle and post timestamp of the original submitter. |

## 9. Deal Submission Flow

Available to any signed-in user, on web, iOS, or Android. Steps:

1. **Paste URL.** User pastes the direct product/promotion link into the submission form.
2. **Duplicate check.** System normalizes and checks the URL before proceeding (see §10). If a match exists, block submission with an error and link to the existing deal.
3. **Auto-populate.** System fetches the URL server-side and attempts to extract: Title, Image, Price (full/current), Store/retailer name. Extraction method: *TBD* — e.g., Open Graph / structured data (schema.org `Product`, `application/ld+json`) parsing, with a defined fallback if the retailer blocks scraping or lacks structured metadata.
4. **Review & edit.** All auto-populated fields are editable before submit: Title, Image, Category (user must choose from the predefined list — not auto-set unless confidently inferred), Price (full + discounted), Store.
5. **Deal details.** User adds free-text details (manually entered, not auto-populated): terms, promo code, expiration, shipping/membership requirements.
6. **Submit.** Deal is published immediately *(or enters a review queue — TBD, see Open Questions)* and appears in Latest/Listings.

### 9.1 Auto-populate failure handling

If the URL cannot be scraped (JS-rendered page, bot-blocked, paywalled, malformed URL), the form must degrade gracefully: show an inline notice ("Couldn't auto-fill details — please complete manually") and leave all fields blank/editable rather than blocking submission entirely.

### 9.2 Predefined category list

*Initial category taxonomy TBD — owned by Admins, editable via Admin Mode (see §15). Example starter set: Electronics, Home & Kitchen, Fashion, Grocery, Travel, Gaming, Software/Services, Toys & Kids, Health & Beauty, Other.*

### 9.3 Browser extension (one-click submission)

A companion browser extension (Chrome/Edge, with others *TBD*) lets a signed-in user submit the product page they're currently viewing without manually copying the URL:

- Toolbar button detects the current tab's URL and opens a lightweight submission popup pre-filled via the same auto-populate pipeline as the web/app submission form (§9 steps 2–5).
- Runs the same duplicate check (§10) before allowing submission, surfacing the same "already posted" error with a link to the existing deal.
- Supports the same review-and-edit step (title, image, category, price, store) before the user confirms submission — no auto-submit without user confirmation.
- Requires the user to be signed in (shared auth/session with web, per §17); prompts sign-in if not authenticated.
- Distribution (Chrome Web Store, Edge Add-ons, Firefox) and manifest/permissions scope: *TBD*.

## 10. Duplicate Detection

Goal: if a URL is already posted as an active deal, block re-submission with a clear error. A raw string comparison of URLs is insufficient (tracking/affiliate params, protocol, and trailing slashes vary) — URLs must be **canonicalized** before comparison.

### 10.1 Canonicalization rules (proposed)

- Lowercase scheme + host; strip `www.`.
- Strip known tracking/affiliate query params (`utm_*`, `ref`, `aff_id`, `tag`, click-id params, etc.) — exact param blocklist *TBD per retailer*.
- Strip trailing slash and fragment (`#...`).
- Optionally resolve known URL shorteners to their final destination before hashing.

### 10.2 Enforcement

- Store a hash (e.g., SHA-256) of the canonicalized URL with a **unique database constraint** — not just an application-level check — to prevent race conditions from double-submits.
- On duplicate detection: reject with a specific error message (e.g., "This deal has already been posted") and a link to the existing live deal.
- Interaction with deletion: if the existing deal was removed by a moderator, does the URL become postable again? *TBD, see Open Questions*.

## 11. Voting (Upvote / Downvote)

- Available on the Deal Detail page and inline on deal cards (Homepage, Listings) across web, iOS, and Android.
- One vote per signed-in user per deal: up, down, or none. Selecting the opposite vote replaces the current one; selecting the same vote again clears it.
- Voting requires sign-in; signed-out users see the counts but are prompted to sign in on tap/click.
- Net score (upvotes − downvotes) drives the Hot Deals ranking (§6) and is displayed on the deal.
- Self-voting: does a poster's own upvote on their deal count? *TBD — recommend excluding to reduce gaming.*

## 12. Comments

- Comments are **publicly readable** by anyone, including signed-out visitors, on web and in the iOS/Android apps.
- Posting a comment **requires sign-in**.
- Flat or threaded replies: *TBD* (flat recommended for v1).
- Moderators/Admins can remove/hide individual comments (abuse, spam) from Admin Mode (§15); removal is logged for audit.
- Basic abuse controls (rate limiting, reporting a comment) — *scope TBD, recommended for v1 given public posting*.

## 13. Bookmarks / Wishlist

- Signed-in users can save any deal to a personal "Wishlisted Deals" list via the Bookmark button on the Deal Detail page.
- Accessible from the user's account/profile area; supports un-bookmarking.
- If a bookmarked deal is later removed by a moderator, it remains visible in the wishlist with a "No longer available" state rather than silently disappearing — *confirm with stakeholders*.

## 14. Share

- Share button on the Deal Detail page produces a canonical, publicly-accessible URL for that deal (works for signed-out visitors landing from the shared link, including opening it on web).
- iOS/Android apps use the native OS share sheet (UIActivityViewController / Android `Intent.ACTION_SEND`); "Copy link" fallback on all surfaces.
- Shared link should render Open Graph tags (title, image, price) for rich previews in Slack/iMessage/social apps, and deep-link back into the native app if installed.

## 15. Admin & Moderator Panel (Admin Mode)

A role-gated section within the standard **desktop web** app — not a separate application and not part of the iOS/Android consumer apps. Visible navigation entry point only for users with Moderator or Admin role. See §4 for the full platform-by-surface breakdown.

| Feature | Moderator | Admin |
|---|---|---|
| Queue of reported/flagged deal posts | ✓ | ✓ |
| Delete a deal post (soft delete + audit log) | ✓ | ✓ |
| Remove/hide a comment | ✓ | ✓ |
| View user list / account status | *TBD* | ✓ |
| Suspend or ban a user account | *TBD* | ✓ |
| Promote User → Moderator | ✗ | ✓ |
| Demote Moderator → User | ✗ | ✓ |
| Manage category taxonomy | ✗ | ✓ |
| Audit log of moderation actions | view own | view all |

**Deletion semantics:** deal deletion should be a soft delete (status flag, not hard row delete) so votes/comments/bookmarks history and audit trail are preserved, and so the URL-dedup decision (§10.2) is well-defined.

> **Security requirement:** all Admin Mode actions must be authorized server-side by role on every API call. The UI gating described above is a convenience, not the access-control boundary.

## 16. Data Model (high level)

| Entity | Key fields |
|---|---|
| **User** | id, email, handle, role (user/moderator/admin), status (active/suspended), created_at |
| **Deal** | id, submitted_by (User), title, image_url, category, full_price, discounted_price, store, source_url, canonical_url_hash (unique), details (text), status (active/removed), created_at |
| **Vote** | id, deal_id, user_id, value (+1/-1), created_at — unique on (deal_id, user_id) |
| **Comment** | id, deal_id, user_id, body, status (visible/removed), created_at |
| **Bookmark** | id, user_id, deal_id, created_at — unique on (user_id, deal_id) |
| **Category** | id, name, active (bool) |
| **ModerationAction** | id, actor_id, target_type (deal/comment/user), target_id, action, reason, created_at |

## 17. Non-Functional Requirements

- **Auth:** sign-in required for posting, voting, commenting, bookmarking; browsing and reading comments work signed-out. Shared auth/session system across iOS, Android, and the Admin Mode web app.
- **Authorization:** role checks enforced server-side (see §3, §15) — identical rules regardless of which client (iOS, Android, web) calls the API.
- **Performance:** homepage sections and listings should paginate/virtualize on all clients; target page-load and interaction latency *TBD*.
- **Abuse prevention:** rate limit deal submissions, votes, and comments per user to deter spam/vote manipulation.
- **Auditability:** all moderation actions (delete, role change, ban) are logged with actor, target, timestamp, reason.
- **Platform parity:** consumer-facing features (§6–§14) ship with equivalent functionality on iOS and Android; Admin Mode (§15) is desktop-web-only and is not required on mobile.
- **App store compliance:** iOS/Android builds must meet Apple App Store and Google Play UGC/moderation policy requirements (report/block/remove flows for comments and deal posts).

## 18. Out of Scope (v1)

- A separate native or standalone app for Admins/Moderators — Admin Mode is desktop-web-only (see §4).
- Price-drop/expiration alerting or automated deal expiry detection.
- Monetization (affiliate links, sponsored placements).
- Threaded comment replies, comment upvoting (unless added in a later phase).

## 19. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| URL scraping is unreliable across retailers (anti-bot, JS rendering), degrading auto-populate | **High** | Graceful manual-fallback form (§9.1); consider retailer-specific parsers for top N stores over time. |
| Vote manipulation (sockpuppet accounts, brigading) | **High** | Rate limiting, one-vote-per-user constraint, anomaly monitoring, exclude self-votes. |
| Spam/fake/expired deal posts | **Medium** | Moderator delete tooling + report queue (§15); consider a trust/reputation gate before unrestricted posting. |
| Dedup bypassed via shortened/mirrored/parameterized URLs | **Medium** | Canonicalization rules (§10.1); expand blocklist/shortener-resolution over time. |
| Public comments enable harassment/abuse | **Medium** | Report + remove tooling, rate limiting, audit log. |
| iOS/Android apps maintained as separate codebases drift out of feature parity with each other | **Medium** | Shared backend/API contract across platforms; consider a cross-platform framework (React Native/Flutter) to reduce duplicate implementation effort — decision *TBD*. |
| App Store / Google Play review cycles delay releases (esp. moderation-sensitive UGC features like comments) | **Medium** | Budget review buffer in release planning; ensure content-moderation controls (report/remove) are in place before submission, per store UGC policies. |

## 20. Open Questions

1. What is the exact "Hot Deals" ranking formula, including time-decay weighting?
2. What signals power "For You" personalization, and what is the signed-out / new-user (cold-start) fallback?
3. Does a deal go live immediately on submission, or enter a pre-publish moderation queue?
4. If a moderator removes a deal, does its URL become re-postable, or does the dedup hash remain blocked permanently?
5. What happens to votes/bookmarks/comments tied to a removed (soft-deleted) deal — preserved, hidden, or purged?
6. Does a user's own upvote count toward their own deal's score?
7. Can Moderators suspend/ban users, or is that Admin-only?
8. Who owns/edits the predefined category list initially, and can it change post-launch?
9. What anti-spam/report mechanism exists for comments (user-facing "report" button)?
10. What are the actual success-metric targets (engagement rate, removal rate, submission volume)?
11. Do iOS and Android launch simultaneously, or is one platform prioritized first? Is there a cross-platform framework decision (native Swift/Kotlin vs. React Native/Flutter) already made?
12. Do consumer mobile apps need push notifications (e.g., price-drop/deal alerts) at launch, or is that a later phase?
13. Which browsers must the extension support at launch (Chrome/Edge only, or also Firefox/Safari), and who owns store listing/review for each?

## 21. Phasing (proposed)

| Phase | Scope |
|---|---|
| **Phase 1 — Core (Web)** | Auth, deal submission (manual + auto-populate), Listings page, Deal Detail page, voting, bookmarks, share, basic comments on desktop/mobile web. |
| **Phase 2 — Community & Moderation** | Dedup enforcement, Moderator/Admin roles, Admin Mode (delete deals/comments, role promotion), audit log — desktop web. |
| **Phase 3 — Discovery** | Homepage Latest/Hot/For You sections, personalization model, category filters. |
| **Phase 4 — Native Apps** | iOS and Android apps covering the full consumer feature set (§4–§14) at parity with web; Admin Mode remains desktop-web-only. |
| **Phase 5 — Browser Extension** | One-click submission extension (§9.3) reusing the web submission/auto-populate/dedup pipeline. |

> **Note:** timeline and resourcing not provided — phases are a suggested sequencing only, not a committed schedule.

---

*Deal-Sharing Community Platform · PRD v1.0 · Draft for review · fields marked* TBD *require stakeholder input before engineering estimation.*
