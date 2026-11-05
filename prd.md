# ShareDeals.in: Deal-Sharing Community Platform

**Product Requirements Document**

A Slickdeals-style community where users post, discover, vote on, and discuss time-sensitive deals from Indian stores, with community moderation and personalized discovery. Consumers use the website and an Android app (iOS later); Admins/Moderators moderate from a desktop web Admin Mode.

| | |
|---|---|
| **Status** | v1.1: updated to match what has been built (v1.0 was the original draft) |
| **Market** | India only: Indian stores, prices in ₹ with MRP |
| **Site** | `https://www.sharedeals.in` |
| **Document Owner** | *TBD* |
| **Engineering Lead** | *TBD* |
| **Target Release** | *TBD* |
| **Last Updated** | Nov 3, 2026 |

> **How to read this version:** each section states the requirement and, where it has been built, how it was built. **Built** means the code exists and is deployed to the website. **Built, not yet live** means the code exists but depends on store accounts, keys or device testing that haven't happened yet. **Planned** means not built. Engineering detail lives in [README.md](README.md), [PROJECT_NOTES.md](PROJECT_NOTES.md) and [mobile/README.md](mobile/README.md).

## What changed since v1.0 (Oct 7, 2026)

| Area | Change | Section |
|---|---|---|
| Market | Scoped to **India**: ₹ prices with MRP, Indian stores and categories | §1, §9.2 |
| Deals model | A deal is now a **product**; each store's link is an **offer** on it, so one deal can list Amazon, Flipkart and Croma side by side | §9.5 |
| Posting | **Approved stores only** (10 Indian retailers) | §9.4 |
| Duplicates | Product-ID dedup per retailer, "same product from another store" matching, and moderator merge | §10 |
| Discovery | Hot, For You and Latest formulas decided; For You now uses page views; signed-out visitors don't see For You | §6 |
| Deal page | Breadcrumbs, Similar deals carousel, SEO titles and slug URLs | §8 |
| New: Alerts | Saved-search alerts and interest-based deal alerts, pushed to the Android app | §13a |
| New: Accounts | Google/Facebook sign-in, forgot and change password, account deletion | §17a |
| New: Feedback | Feedback form on every page, read in Admin Mode | §15a |
| New: SEO and speed | Server-rendered pages, sitemap, structured data, IndexNow, image and font optimization | §17b |
| Extension | One-click posting directly from Amazon, Flipkart and Myntra listing pages | §9.3 |
| Platforms | Android app built as a Capacitor shell around the website; iOS deferred | §4 |
| Open questions | All 13 answered | §20 |

---

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
13a. [Alerts & Push Notifications](#13a-alerts--push-notifications)
14. [Share](#14-share)
15. [Admin & Moderator Panel](#15-admin--moderator-panel-admin-mode)
15a. [Feedback](#15a-feedback)
16. [Data Model](#16-data-model-high-level)
17. [Non-Functional Requirements](#17-non-functional-requirements)
17a. [Accounts & Sign-in](#17a-accounts--sign-in)
17b. [SEO, Performance & Analytics](#17b-seo-performance--analytics)
18. [Out of Scope](#18-out-of-scope-v1)
19. [Risks & Mitigations](#19-risks--mitigations)
20. [Open Questions (resolved)](#20-open-questions-resolved)
21. [Phasing & Status](#21-phasing--status)

---

## 1. Overview & Problem Statement

Indian shoppers waste time hunting across Flipkart, Amazon.in, Myntra, AJIO, Nykaa, Meesho and other retailer sites for discounts, and have no reliable, community-vetted place to find, validate, and share deals in real time. Existing social channels (WhatsApp/Telegram groups, forums) lack structure: no dedup, no voting signal, no personalization, and no moderation against spam or expired/fake deals.

We will build a community-driven deals platform where any signed-in user can submit a deal by pasting a URL, the community upvotes/downvotes and discusses deals in comments, and a lightweight moderation layer (Moderators + Admins) keeps the catalog clean. Discovery is surfaced three ways on the homepage: newest, hottest (most upvoted), and personalized ("For You").

> **Primary user outcome:** find a legitimately good, currently-valid deal faster than searching retailer sites or social media, with visible community trust signals (votes, comments).

**India localization (built):**
- Prices in ₹ with Indian digit grouping (₹1,29,999); the full price is labelled **MRP**. Price fields accept `₹`, `Rs.` and lakh-grouped input.
- Store names auto-detected for about 25 Indian retailers.
- Share previews use `INR` and `en_IN`.

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|---|---|---|
| Drive deal discovery | Weekly active users viewing a deal detail page | *TBD — needs baseline* |
| Community engagement | % of deal views resulting in a vote or comment | *TBD* |
| Submission quality | % of submitted deals removed by moderators | *TBD, directionally <5%* |
| Submission volume | Deals posted per day | *TBD* |
| Retention | Return visits via bookmarked/wishlisted deals and alert notifications | *TBD* |

> **Note:** target numbers are still placeholders pending input from the business owner. The events needed to measure them are now tracked in Google Analytics (§17b).

## 3. Roles & Permissions

Three roles. Permissions are enforced **server-side** on every mutating endpoint; hiding admin UI controls on the client is not access control.

| Capability | User | Moderator | Admin |
|---|---|---|---|
| Browse deals, vote, comment, share, bookmark | ✓ | ✓ | ✓ |
| Submit a new deal, or add a store link to an existing deal | ✓ | ✓ | ✓ |
| Edit own deal submission | ✓ | ✓ | ✓ |
| Delete any deal post or store link | ✗ | ✓ | ✓ |
| Merge duplicate deals | ✗ | ✓ | ✓ |
| Remove / hide a comment | ✗ | ✓ | ✓ |
| Access Admin Mode (desktop web only) | ✗ | ✓ | ✓ |
| Suspend / ban a user account | ✗ | ✗ | ✓ |
| Promote a User to Moderator | ✗ | ✗ | ✓ |
| Demote a Moderator to User | ✗ | ✗ | ✓ |
| Manage category list | ✗ | ✗ | ✓ |
| Read user feedback | ✗ | ✓ | ✓ |
| Posting rate limits apply | ✓ | ✗ | ✗ |

- Admins can't modify other Admins and can't create new Admins from the UI; new Admins are created from the server command line (`npm run make-admin`).
- Suspended users can browse but not post, vote, or comment. Banned users are signed out everywhere and can't sign in.

**Platform access:** Admins and Moderators perform all moderation and user-management actions in **Admin Mode** within the desktop website. No separate native admin app or standalone admin tool exists.

## 4. Platform Strategy

| Surface | Audience | Scope | Status |
|---|---|---|---|
| **Website (desktop and mobile)** | Consumers, Moderators, Admins | Full consumer experience *plus* Admin Mode (§15). Mobile-first responsive layout with a bottom tab bar. | **Built** |
| **Android app** | Consumers | Full consumer experience, plus native share sheet, back button, deep links, Google/Facebook sign-in via a Chrome tab, store links opening the Flipkart/Amazon app, and push notifications (§13a). | **Built, not yet live:** not yet run on a device or published to Google Play |
| **iOS app** | Consumers | Same as Android. | **Planned.** Also needs Sign in with Apple, Universal Links and user blocking (Apple requirements). |
| **Browser extension** | Consumers | One-click deal submission only (§9.3). | **Built** (Chrome/Edge, installed unpacked; not yet in the Chrome Web Store) |

- **Framework decision:** the Android app is a **Capacitor** shell that loads the live website in a full-screen WebView and adds native features through Capacitor's bridge. Website changes reach the app without a Play Store update; only changes in `mobile/` need a new release. iOS can be added from the same project.
- **Admin Mode is desktop-web-only.** It is not shown in the Android app.
- **The extension is submission-only**; it doesn't browse, vote or comment.
- All surfaces use the same backend and API, so votes, comments, bookmarks, submissions, alerts and moderation state stay consistent across clients.

## 5. User Stories

| ID | As a… | I want to… | So that… | Status |
|---|---|---|---|---|
| US-1 | Visitor/User | see deals sorted newest-first on a listings page | I can quickly scan what's fresh | Built |
| US-2 | User | open a deal and see its image, price, discount, and details | I can judge if it's worth buying | Built |
| US-2b | User | upvote or downvote a deal | I can signal deal quality to others | Built |
| US-3 | Signed-in user | comment on a deal | I can ask questions or share experience | Built |
| US-4 | Signed-in user | bookmark a deal to my wishlist | I can find it again later | Built |
| US-5 | User | share a deal link outside the app | I can tell friends/family | Built |
| US-6 | User | see a "Hot Deals" section ranked by upvotes | I can find the most community-validated deals | Built |
| US-7 | User | see a "For You" section | I see deals relevant to my interests | Built |
| US-8 | Signed-in user | submit a deal by pasting a URL | I don't have to manually fill every field | Built |
| US-9 | Signed-in user | edit auto-populated fields before posting | I can correct inaccurate scraped data | Built |
| US-10 | User | be blocked from posting a URL that's already listed | the catalog doesn't fill with duplicates | Built |
| US-11 | Moderator | delete a spam/expired deal post | the catalog stays clean | Built |
| US-12 | Admin | promote a trusted user to Moderator | I can scale moderation capacity | Built |
| US-13 | Admin | control who can use the platform | I can remove bad actors | Built |
| US-14 | User | browse, vote, comment, bookmark, and submit deals from a native iOS or Android app | I can use the platform on the go | Android built, not yet live; iOS planned |
| US-15 | Moderator/Admin | moderate deals and users from a desktop browser | I don't need a separate admin app | Built |
| US-16 | Signed-in user | submit the product page I'm viewing via a one-click browser extension | I don't have to copy/paste the URL | Built |
| US-17 | Signed-in user | add another store's link to a deal that's already posted | shoppers can compare prices for the same product in one place | Built |
| US-18 | Signed-in user | save a search phrase as an alert and get notified of new matching deals | I don't miss deals I'm waiting for | Built, not yet live (push needs Firebase) |
| US-19 | Signed-in user | get notified about new deals that match my interests | I find relevant deals without checking the site | Built, not yet live (push needs Firebase) |
| US-20 | User | reset a forgotten password or change my password | I don't lose access to my account | Built |
| US-21 | Signed-in user | delete my account and data | I control my personal data (Google Play and DPDP requirement) | Built |
| US-22 | Visitor/User | send feedback from any page | the team hears about bugs and ideas | Built |
| US-23 | Visitor | find ShareDeals deal pages from Google search | I land on a relevant deal directly | Built |
| US-24 | Moderator | merge two posts for the same product | votes and comments end up on one deal | Built |

## 6. Homepage

| Section | Sort basis | Built as |
|---|---|---|
| **For You** | Personalization | Shown first, **only to signed-in users**. Signals and weights in the table below. Users with no history see Hot deals, labelled "Trending". |
| **Latest** | `created_at` descending | Up to 100 deals, with a "See all" link to Listings. Leads the page for signed-out visitors. |
| **Hot Deals** | Net score with time decay | `score / (age_hours + 2)^1.5` over a 14-day window (Hacker-News style). Shown in a right-hand column on desktop. |

**For You signals (built):**

| Signal | Weight / effect |
|---|---|
| Category affinity | bookmark +3, upvote +2, downvote −2, comment +1, deal page visit +1, category page visit +1.5; visits fade with a 14-day half-life |
| Product affinity | words from the titles of deals the user opened (brands, product types), so interest carries across categories |
| Store affinity | stores whose deals or store pages the user visits |
| Exclusions | deals the user posted, voted on, or bookmarked |
| Freshness | deals the user opened in the last 3 days are pushed down |

Each deal card shows: thumbnail, title, store, price, MRP (struck through), net vote score, comment count, and inline thumbs-up/down voting. The posted time was removed from cards to keep them uncluttered.

## 7. Listings Page

- Full, infinite-scroll feed of all active deals at `/deals`. **Built.**
- Sort: Newest (default) or Hot.
- Filter by category chips; keyword search.
- **Category pages** at `/c/<slug>` and **store pages** at `/store/<slug>` (also used for SEO, §17b).
- Removed and merged deals are excluded.
- Store and price-range filters remain nice-to-have.

## 8. Deal Detail Page

Route: `/deals/:id/<title-slug>` (the slug is optional; old `/deals/:id` links still work). All elements below are **built**.

| # | Element | Behavior |
|---|---|---|
| 8.1 | Product image | Captured at submission (auto-pulled or user-replaced); served at display size from the store's CDN, WebP where offered. |
| 8.2 | Item title | Submitted/edited title. |
| 8.3 | Full price (MRP) | Struck through. |
| 8.4 | Discounted price | Shown prominently with discount %. When several stores carry the deal, the headline price is the cheapest active offer. |
| 8.5 | Upvote / downvote | Thumbs icons; one vote per user per deal (§11). |
| 8.6 | Deal details | Poster's free text (terms, coupon code, expiry, shipping). |
| 8.7 | Comments | Public to read; sign-in to post (§12). |
| 8.8 | Bookmark / Save | Adds to Wishlist (§13). |
| 8.9 | Share | Native share sheet or copy link (§14). |
| 8.10 | Store links | One **Get deal** button per store offer (§9.5). In the Android app, opens the Flipkart/Amazon app if installed. |
| 8.11 | Category badge | The deal's category. |
| 8.12 | Poster attribution | Handle and post time. |
| 8.13 | Breadcrumbs *(new)* | Home › Category › Deal; also emitted as structured data. |
| 8.14 | Similar deals *(new)* | Carousel of up to 10 deals from the same category, ranked by shared title words, then newest. |
| 8.15 | Add a store *(new)* | "Add my ⟨store⟩ link to this deal" for users who found the same product elsewhere. |
| 8.16 | Report *(new)* | Report a deal or an individual store link to moderators. |

## 9. Deal Submission Flow

Available to any signed-in user on the website, the Android app, and via the extension. **Built.**

1. **Paste URL.** Must be from an approved store (§9.4); other sites are refused before anything is fetched.
2. **Duplicate check** (§10). An exact match is blocked with a link to the existing deal. A likely match from another store offers "Add my link to this deal" or "Post a new deal anyway".
3. **Auto-populate.** Server-side fetch extracts title, image, price, MRP, store, category, GTIN and MPN, from JSON-LD `Product`, Open Graph and product meta tags, with Amazon-specific parsing (Amazon.in has no JSON-LD). Category is guessed from breadcrumbs and the title.
4. **Review & edit.** All fields editable before submit.
5. **Deal details.** Free text added by the user.
6. **Submit.** Published immediately (no pre-publish queue).

### 9.1 Auto-populate failure handling

**Built.** If the page can't be fetched or parsed (stores often send bot checks to cloud servers), the form shows a notice and leaves fields empty for manual entry rather than blocking submission. The browser extension avoids this problem by sending the page as the user sees it (§9.3).

### 9.2 Predefined category list

**Built.** Admin-owned and editable in Admin Mode (add, rename, hide). Seeded as: Mobiles, Electronics, Fashion, Beauty & Personal Care, Home & Kitchen, Grocery, Travel, Gaming, Toys & Kids, **Books**, Apps & Services, Other. Book pages are recognized by breadcrumbs, ISBN, format subtitle or JSON-LD `Book`.

### 9.3 Browser extension (one-click submission)

**Built** (v1.2.0, Chrome/Edge MV3).

- **Product pages:** the toolbar button opens a popup that *is* the website's Post a deal page, so it uses the normal session (sign-in prompt if needed), the same dedup and the same review-and-edit step. Nothing posts until the user confirms.
- **Page snapshot:** the extension copies product details from the page the user sees (meta tags, JSON-LD, Amazon's price box and breadcrumbs, MRP labels; about 10–40 KB) so auto-fill works even when the store blocks server fetches.
- **Listing pages *(new)*:** quick-post buttons on product thumbnails on Amazon (search, store and deal-grid pages), Flipkart and Myntra listings. The deal is posted, or the link is added to an existing deal, in the background, with a notification.
- **Site selection:** defaults to `www.sharedeals.in`, falling back to the Railway address if it's down; configurable on the Options page.
- **Distribution:** installed unpacked for now. Chrome Web Store / Edge Add-ons listing and Firefox support are *planned*.

### 9.4 Approved stores *(new)*

**Built.** Deals can only be posted from: Amazon.in, Flipkart, Meesho, Snapdeal, Myntra, Tata CLiQ, AJIO, JioMart, Croma and Nykaa.
- Checked server-side for auto-fill, new deals and added store links, so it covers the website, the extension and the API alike.
- Matching uses the registrable domain (`dl.flipkart.com` is fine; look-alike domains are refused). Short links (`amzn.in`, `fkrt.it`, `bit.ly`…) are judged by where they lead.

### 9.4a Prohibited products *(new)*

**Built.** Adult/sexual products, weapons (guns, ammunition, knives made for fighting, explosives) and offensive items can't be posted at all; there's no moderation step. Deals and store links are checked on title, details, note and link when posted or edited. Admins maintain the blocked words, and "allowed" exceptions such as "massage gun", in Admin Mode → Blocked words.

### 9.5 One deal per product, many store offers *(new)*

**Built.** A deal represents a **product** (e.g. "Google Pixel 10a 256 GB"). Each store's link is an **offer** on that deal with its own price and MRP.
- One active offer per store per deal.
- Offers store the poster's exact URL. **Amazon.in links are shown with ShareDeals' own Amazon Associates tag** (when `AMAZON_ASSOCIATE_TAG` is set), replacing any tag the poster used; other stores' links are shown as posted.
- The deal's headline price and store come from its cheapest active offer.
- Moderators can remove or restore individual offers.

## 10. Duplicate Detection

**Built.**

### 10.1 Canonicalization

- Lowercase scheme and host; strip `www.`, trailing slash and fragment; strip tracking/affiliate parameters.
- Reduce product links to their product ID: Amazon.in (ASIN), Flipkart (`itm…` + `pid`), Myntra (style ID), Nykaa (product + `skuId` shade), AJIO, Meesho. This catches the same product shared from the app, search results or an affiliate link.
- Short links (`fkrt.it`, `amzn.in`, `myntr.it`, `amzn.to`) are followed to the product page first.

### 10.2 Enforcement

- SHA-256 hash of the canonical URL with a **partial unique database index**: only one *active* offer per link, so concurrent double-submits can't both succeed.
- Exact duplicate: rejected with "This deal has already been posted" and a link to it.
- **Removed deals free their URLs** for re-posting. Restoring a removed deal fails if its URL has since been re-posted.

### 10.3 Same product from another store *(new)*

- New submissions are scored against existing deals on title, GTIN and MPN similarity.
- On a likely match the user sees **"This product is already on ShareDeals"** and can add their store link to that deal, or confirm it's a different product and post a new deal. The server enforces this (409 with matches unless confirmed).
- **Moderator merge:** Admin Mode lists likely duplicate pairs; merging moves offers, votes and comments into one deal and redirects (301) the merged deal's URL.

## 11. Voting (Upvote / Downvote)

**Built.**
- On the deal page and inline on cards; thumbs-up/down icons.
- One vote per signed-in user per deal. The opposite vote replaces it; the same vote again clears it.
- Signed-out users see counts and are prompted to sign in.
- Net score drives Hot (§6).
- **Self-votes are blocked**; vote buttons are disabled on your own deals.

**Downvote reasons (built).** A downvote asks why: *Deal expired* or *Price is high*.
- *Deal expired* marks the deal expired (`EXPIRE_VOTES`, currently 1 vote). It stays reachable and tagged "Expired" in All deals, but leaves the home page, Hot, For You, similar deals and alerts. Taking the vote back undoes it. The poster or a moderator can also mark it expired or bring it back.
- *Price is high* is a normal downvote, counted on the deal page.

**Planned:** *Wrong info* and *Spam or repost* reasons. Details in [PROJECT_NOTES.md §14](PROJECT_NOTES.md).

## 12. Comments

**Built.**
- Publicly readable; posting requires sign-in.
- Flat (not threaded).
- **Report** button on each comment feeds the moderation queue.
- Moderators can remove and restore comments; actions are logged.
- Rate limited per user.

## 13. Bookmarks / Wishlist

**Built** at `/saved`.
- Save and un-save from the deal page or cards.
- Removed deals stay visible as "No longer available".
- A **My posts** tab lists the user's own deals.

## 13a. Alerts & Push Notifications *(new)*

**Built, not yet live.** Push notifications need `FIREBASE_SERVICE_ACCOUNT` on the server and `google-services.json` in the app build. Notifications are sent to the **Android app only**; the website shows alerts and their matches but doesn't send browser notifications.

**Saved-search alerts**
- An **Alerts** tab (bottom bar on phones, header link on desktop) where signed-in users add up to **10 phrases** (e.g. "iphone 15", "lego technic"), also from search results. They can edit, delete and see matching deals.
- An hourly job finds deals posted since each alert that contain every word of the phrase (in the title or store), and sends **one notification per user per run**. Each deal is announced at most once per alert. Only one server instance runs the job.

**Interest-based deal alerts**
- When a new deal strongly matches a user's For You interests (§6), the server pushes it.
- At most **6 per user per day**; never for the user's own deal. Tapping opens the deal in the app.

**Measurement:** GA events for permission, receipt and open; sends are recorded server-side when `GA_API_SECRET` is set.

## 14. Share

**Built.**
- Canonical, public deal URL with a keyword slug (`/deals/<id>/<slug>`).
- Native share sheet (Web Share API on web, Android share sheet in the app); copy-link fallback.
- Server-rendered Open Graph tags (title, image, price, MRP) for rich previews in WhatsApp, Slack and social apps.
- **Deep links:** shared `/deals/…` links open in the Android app via App Links once the Play-signed app is live (`/.well-known/assetlinks.json` is served from `ANDROID_CERT_SHA256`).

## 15. Admin & Moderator Panel (Admin Mode)

**Built** at `/admin`, desktop web only, visible only to Moderators and Admins.

| Feature | Moderator | Admin |
|---|---|---|
| Summary dashboard | ✓ | ✓ |
| Report queue (deals, store links, comments), with dismiss | ✓ | ✓ |
| Deals list, sortable by posted date | ✓ | ✓ |
| Remove / restore a deal (soft delete + audit log) | ✓ | ✓ |
| Remove / restore an individual store offer | ✓ | ✓ |
| Likely-duplicates list and merge | ✓ | ✓ |
| Remove / restore a comment | ✓ | ✓ |
| Feedback inbox (§15a) | ✓ | ✓ |
| User list; suspend, ban, reinstate | ✗ | ✓ |
| Promote User → Moderator / demote | ✗ | ✓ |
| Manage categories | ✗ | ✓ |
| Audit log of moderation actions | ✓ | ✓ |

**Deletion semantics:** soft delete. Votes, comments and bookmarks are preserved, so restoring a deal brings them back.

> **Security requirement:** all Admin Mode actions are authorized server-side by role on every API call.

## 15a. Feedback *(new)*

**Built.**
- `/feedback` form, open to signed-in users and guests; rate limited.
- A side **Feedback** tab on every page opens the form with the current page filled in (hidden on the feedback page and in Admin Mode). Also linked from the footer and the account page.
- Admin Mode → **Feedback** lists submissions with a new/done status.

## 16. Data Model (high level)

| Entity | Key fields |
|---|---|
| **User** | id, email, handle, role (user/moderator/admin), status (active/suspended/banned/deleted), password hash (optional for social-only accounts), created_at |
| **OAuthIdentity** *(new)* | provider (google/facebook), provider user ID, user_id |
| **Session** | token hash, user_id, expires_at |
| **Deal** | id, submitted_by, title, image_url, category_id, details, gtin, mpn, status (active/removed), expired_at, expired_by, merged_into, upvotes, downvotes, score, best_price, best_full_price, best_store, offer_count, timestamps |
| **Offer** *(new)* | id, deal_id, submitted_by, store, source_url (as posted), canonical_url, canonical_url_hash (unique while active), price, full_price (MRP), note, status (active/removed/deal_removed) |
| **Vote** | deal_id, user_id, value (+1/−1); unique on (deal_id, user_id) |
| **Comment** | id, deal_id, user_id, body, status (visible/removed), created_at |
| **Bookmark** | user_id, deal_id, created_at; unique on (user_id, deal_id) |
| **Category** | id, name, slug, active |
| **Report** | target (deal/offer/comment), reason (spam, expired, wrong_price, duplicate, offensive, other), reporter, status |
| **ModerationAction** | actor_id, target_type, target_id, action, reason, created_at |
| **PageView** *(new)* | user_id, kind (deal/category/store), target, viewed_at; feeds For You |
| **Alert** *(new)* | id, user_id, phrase; **AlertHit**: alert_id, deal_id (each deal announced once per alert) |
| **PushToken / PushLog** *(new)* | FCM token per user; log of notifications sent (kind: interest match or alert) |
| **PasswordReset** *(new)* | token hash, user_id, expires_at, used_at |
| **AppLoginCode** *(new)* | one-time code for the Android sign-in hand-off |
| **Feedback** *(new)* | message, page, user (optional), status (new/done) |

Prices are stored as integer paise; timestamps as epoch milliseconds. Schema changes are append-only migrations applied on boot (currently 7).

## 17. Non-Functional Requirements

- **Auth:** sign-in required for posting, voting, commenting, bookmarking and alerts; browsing and reading comments work signed-out. One session system across website, Android app, extension and Admin Mode. See §17a.
- **Authorization:** role checks enforced server-side, identical for every client.
- **Performance:** infinite scroll on all lists; first-screen data embedded in the page. See §17b.
- **Abuse prevention:** per-user rate limits on submissions, votes, comments, reports, feedback and page-view logging; per-IP limits on sign-in, registration and password reset. Moderators and Admins are exempt from posting limits so they can seed deals in bulk. *Limits are kept in memory per server instance; move to a shared store before running several instances.*
- **Security:** scrypt password hashing, HttpOnly session cookies (Secure in production), CSRF defenses, strict Content Security Policy, SSRF-guarded server fetches.
- **Auditability:** all moderation actions are logged with actor, target, timestamp and reason.
- **Platform parity:** consumer features are the same on website and Android because the app runs the website. Admin Mode is desktop-web-only.
- **App store compliance:** report and remove flows for deals and comments, in-app account deletion and a public `/delete-account` page, `/privacy` and `/terms` pages. *Privacy policy and terms still need legal review before launch (DPDP Act 2023).*
- **Reliability:** health check at `/api/health` returns 503 when the database is unreachable; the server refuses to start in production without `DATABASE_URL`.

## 17a. Accounts & Sign-in *(new)*

**Built.**
- **Email and password** registration and sign-in.
- **Google and Facebook sign-in** (server-side OAuth). The first social sign-in creates an account, or links to an existing account with the same verified email. In the Android app, sign-in runs in a Chrome tab and hands back to the app with a one-time code.
- **Forgot password:** emails a single-use reset link valid for one hour, sent through Zoho ZeptoMail. The response is the same whether or not the email has an account. Resetting signs out every session.
- **Change password** from Your account (requires the current password; signs out other sessions). Usernames can't be changed.
- **Delete account** on its own page: requires an acknowledgement, the username, the phrase DELETE MY ACCOUNT, and the password for password accounts, all checked server-side. Personal data, comments, votes, saved deals, views and reports are deleted; deals the user posted stay up, anonymized.
- **Sign-out** asks for confirmation.
- **Planned:** email verification.

## 17b. SEO, Performance & Analytics *(new)*

**SEO (built)**
- Each page's title, description, canonical link and main content are rendered on the server for crawlers; the app takes over in the browser.
- Deal page titles follow "‹Product› at ‹N›% off on ‹Retailer› | ShareDeals"; descriptions include the full title, price, discount and retailer.
- `robots.txt` and a live `sitemap.xml` built from the database.
- Structured data: Product/Offer, BreadcrumbList, ItemList, WebSite and Organization.
- Real 404/410 for missing or removed deals, `noindex` on private pages, 301s for merged deals and old links.
- **IndexNow:** search engines are notified when deals are posted, changed or removed.

**Performance (built)**
- Product photos requested at display size (1x/2x) and in WebP where the store's CDN offers it; lazy loading below the fold and high fetch priority for the main image.
- Brotli/gzip compression; stylesheet inlined; analytics deferred; first-screen data embedded in the HTML.
- Self-hosted Google Sans Flex font (also in the Android app's offline screen).
- App code revalidated on every load, so deploys show up immediately.

**Analytics (built)**
- Google Analytics 4 with page views sent on every in-app navigation.
- Events: `get_deal`, `post_deal`, `add_store_link`, `sign_up`, `login`, `vote`, `add_to_wishlist`, `share`, plus alert and push events (§13a).
- **Planned:** GA events for Google and Facebook sign-ins.

## 18. Out of Scope (v1)

- A separate native or standalone app for Admins/Moderators.
- **Price-drop alerts** and automated expiry detection. *(Alerts for **new** deals are now in scope, §13a. Expiry from user downvotes is built, §11.)*
- Sponsored placements and display ads. *(Amazon affiliate links are now built, §9.5; other stores' affiliate programs are planned.)*
- Threaded comment replies and comment upvoting.
- Browser (web push) notifications.

## 19. Risks & Mitigations

| Risk | Severity | Mitigation (status) |
|---|---|---|
| Store scraping is unreliable (bot checks on cloud servers, JS-rendered prices) | **High** | Manual-entry fallback (built); Amazon-specific parsing (built); extension sends the page as the user sees it (built); affiliate product APIs such as Amazon PA-API (planned). |
| Vote manipulation (sockpuppets, brigading) | **High** | Rate limits, one vote per user, self-votes blocked (built); anomaly monitoring (planned). |
| Spam, fake or expired deals | **Medium** | Approved stores only, report queue, moderator removal (built); downvote reasons with expiry (built, §11). |
| Dedup bypassed via shortened or parameterized URLs | **Medium** | Product-ID canonicalization, short-link resolution, cross-store matching and merge (built). |
| Public comments enable harassment | **Medium** | Report and remove tooling, rate limits, audit log (built). |
| iOS and Android drift apart | **Low** | Both run the same website in a Capacitor shell, so features stay in parity. |
| Play / App Store review delays | **Medium** | Moderation, account deletion and legal pages in place before submission (built); Play's closed test of 12 testers for 14 days for personal accounts. |
| Push notifications feel spammy | **Medium** | Caps of 6 interest alerts per day and one saved-search notification per run, never the user's own deal (built). |
| In-memory rate limits don't hold across several server instances | **Low** today | Run one instance, or move limits to a shared store before scaling. |

## 20. Open Questions (resolved)

| # | Question | Decision |
|---|---|---|
| 1 | Hot ranking formula | `score / (age_hours + 2)^1.5`, 14-day window. |
| 2 | For You signals and cold start | Category, product and store affinity from votes, bookmarks, comments and page views (§6). Signed-out visitors don't see For You; users with no history see "Trending" (Hot). |
| 3 | Pre-publish moderation queue? | No; deals go live immediately. |
| 4 | Is a removed deal's URL re-postable? | Yes; only active offers reserve a URL. |
| 5 | Votes/bookmarks/comments on removed deals | Preserved (soft delete); restoring brings them back. |
| 6 | Do self-votes count? | No; blocked. |
| 7 | Can Moderators suspend/ban? | No; Admin only. |
| 8 | Who owns the category list? | Admins, in Admin Mode; can change after launch. |
| 9 | Comment reporting? | Yes; Report button feeds the moderation queue. |
| 10 | Success-metric targets | **Still open:** needs the business owner. |
| 11 | iOS vs Android first; framework | Android first, as a Capacitor shell around the website; iOS later from the same project. |
| 12 | Push notifications at launch? | Yes, in the Android app: saved-search alerts and interest-based deal alerts (§13a). |
| 13 | Extension browsers | Chrome and Edge; Firefox and store listings planned. |

**New open questions**
1. How many "Deal expired" downvotes should expire a deal (currently 1), and should they count against the poster? (§11)
2. When to list the extension in the Chrome Web Store / Edge Add-ons.
3. Which affiliate programs to use for Flipkart, Myntra and the other stores (direct programs or an aggregator such as Cuelinks)?

## 21. Phasing & Status

| Phase | Scope | Status |
|---|---|---|
| **Phase 1: Core (Web)** | Auth, submission with auto-populate, Listings, Deal Detail, voting, bookmarks, share, comments | **Done** |
| **Phase 2: Community & Moderation** | Dedup, roles, Admin Mode, audit log | **Done**, plus cross-store matching, merge, offer moderation and feedback inbox |
| **Phase 3: Discovery** | Homepage Latest/Hot/For You, personalization, category filters | **Done**, plus page-view personalization, similar deals, category and store pages, SEO |
| **Phase 4: Native Apps** | iOS and Android apps | **Android built, not yet live** (needs device testing, Firebase setup and Play publishing); **iOS planned** |
| **Phase 5: Browser Extension** | One-click submission | **Done** (unpacked), plus listing-page quick posting; store listing planned |
| **Phase 6: Engagement** *(new)* | Alerts and push notifications | **Built, not yet live** |
| **Next (planned)** | More downvote reasons; email verification; GA events for social sign-in; iOS app; extension in Chrome Web Store; shared rate-limit store | **Planned** |

**Before production launch:** legal review of privacy policy and terms; Google consent screen in production and Facebook app Live; `ANDROID_CERT_SHA256` set after Play App Signing; Firebase configured for push.

---

*ShareDeals.in · PRD v1.1 · Updated Nov 3, 2026 to reflect what's built · fields marked* TBD *still need stakeholder input.*
