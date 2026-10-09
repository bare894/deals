# ShareDeals Android app

The Android app is a [Capacitor](https://capacitorjs.com) shell. It opens the live ShareDeals site in a full-screen WebView and adds native Android features: the share sheet, the back button, shared deal links opening in the app, Google/Facebook sign-in through a Chrome tab, and store links opening the Flipkart/Amazon app.

Website changes reach the app as soon as they're deployed on Railway, **without a Play Store update**. You only need a new app release when something in `mobile/` changes.

| | |
|---|---|
| App ID (package name) | `in.sharedeals.app` |
| Site the app loads | `server.url` in `capacitor.config.json`, currently `https://deals-production-1ecf.up.railway.app` (switch to `https://www.sharedeals.in` once that works; see step 6) |
| Sign-in return scheme | `in.sharedeals.app://auth` |
| Min / target Android | 7.0 (API 24) / API 36 |

The site detects the app through the `window.Capacitor` object that the app injects, so every native feature is in `public/app.js` (search for `native`). The server side is in `src/oauth.js` (the app sign-in hand-off), `src/routes/auth.js` (`DELETE /api/me`) and `src/app.js` (`/.well-known/assetlinks.json`).

---

## 1. One-time setup on your computer

1. **Install [Android Studio](https://developer.android.com/studio).** On first launch, let it install the Android SDK and an emulator (choose a Pixel device with a recent Android version).
2. **Install Node 22 or later** (already installed if you run the website locally).
3. **Install the app's tools.** From this folder, on a normal internet connection:
   ```bash
   cd mobile
   npm install
   ```
   Then commit the `package-lock.json` it creates.

## 2. Run it on an emulator or your phone

```bash
cd mobile
npx cap sync android     # copies www/ and capacitor.config.json into the Android project
npx cap open android     # opens Android Studio
```

The first time, Android Studio downloads Gradle and its dependencies, which takes a few minutes. Then choose a device in the toolbar and press **▶ Run**.

- **Emulator:** create one in Device Manager if none is listed.
- **Your phone:**
  1. Turn on Developer options: Settings → About phone → tap *Build number* 7 times.
  2. Turn on **USB debugging** in Developer options.
  3. Plug in the phone and accept the prompt.

After changing anything in `mobile/` (config, icons, `www/`), run `npx cap sync android` again.

## 3. What to test

- [ ] App icon and name show as ShareDeals; the splash screen shows the logo.
- [ ] Home, Hot, All deals, search and a deal page load. The header isn't hidden under the status bar.
- [ ] **Sign in with email** works, and you stay signed in after closing and reopening the app.
- [ ] **Continue with Google / Facebook** opens a Chrome tab, you sign in, and you're back in the app, signed in. (Needs the keys set on Railway; see §5.)
- [ ] Vote, comment, save, and post a deal, including adding a store to an existing deal.
- [ ] **Share** opens the Android share sheet; share a deal to WhatsApp.
- [ ] **Get deal** opens the Flipkart/Amazon app if it's installed, otherwise the browser.
- [ ] The **back button** goes back a page, and leaves the app from Home.
- [ ] **Account** (bottom bar) shows Sign out and Delete account. Try deleting a test account.
- [ ] Airplane mode shows the "You're offline" screen; **Try again** recovers once you're back online.
- [ ] Opening a shared `…/deals/123` link from WhatsApp opens the app. This only works with the Play-signed app after §6 step 4; before that, links open in the browser.

## 4. Build a release

Google Play needs an **Android App Bundle (`.aab`)** signed with your **upload key**:

1. In Android Studio, choose **Build → Generate Signed App Bundle or APK → Android App Bundle**.
2. Choose **Create new…** to make an upload keystore. Save it somewhere safe **outside this repo**, such as a password manager vault, and write down the passwords. You need the same key for every future update.
   `.gitignore` already blocks `*.jks`, `*.keystore` and `keystore.properties`.
3. Choose the **release** build. The `.aab` lands in `android/app/release/`.
4. For every new release, raise `versionCode` (1, 2, 3 …) and `versionName` ("1.0.1" …) in `android/app/build.gradle`.

## 5. Server settings the app needs (Railway, app service → Variables)

| Variable | Value |
|---|---|
| `PUBLIC_URL` | The same address as `server.url`: the Railway address for now, then `https://www.sharedeals.in` once that works. Google/Facebook send people back to `<PUBLIC_URL>/auth/…/callback`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | As for the website. The app uses the same web sign-in, so no Android-specific Google or Facebook setup is needed. Make sure the redirect URIs registered with Google and Facebook use the `PUBLIC_URL` address. |
| `ANDROID_CERT_SHA256` | The SHA-256 fingerprint of the **app signing key** (§6 step 4), so shared deal links open in the app. Separate several fingerprints with commas. |

## 6. Publish on Google Play

1. **Create a developer account** at [play.google.com/console](https://play.google.com/console) (US$25 one-time).
   - **Personal** accounts must run a **closed test with at least 12 testers for 14 days** before production.
   - **Organisation** accounts (they need a D-U-N-S number) don't.
2. **Create the app:** name *ShareDeals*, language English (India), App, Free.
3. **Complete "Set up your app":**
   - **Privacy policy:** `https://<your site>/privacy`
   - **App access:** "All or some functionality is restricted". Give reviewers a normal (non-admin) test login.
   - **Ads:** No. (Store links may earn commission, but that isn't ads.)
   - **Content rating:** fill in the questionnaire. It's a social/UGC app: users can interact and share content.
   - **Target audience:** 18+.
   - **Data safety:**
     - *Collected:* email address, name (from Google/Facebook), user IDs, app interactions, in-app search history, other user-generated content (posts, comments), and device or other IDs (Google Analytics).
     - Data is encrypted in transit.
     - *Users can request deletion:* yes. Deletion URL: `https://<your site>/delete-account`.
   - **News app / health / financial features:** No.
   - **Store listing:**
     - App icon: `store/play-icon-512.png`
     - Feature graphic: `store/play-feature-graphic-1024x500.png`
     - At least 2 phone screenshots (take them in the emulator with the camera button)
     - Short description (80 characters), for example *"Community-vetted deals from Flipkart, Amazon, Myntra & more, all in one place."*
     - Full description
4. **Turn on Play App Signing.** It's the default; Google keeps the app signing key, and you keep the upload key. Then:
   1. Go to **Test and release → Setup → App integrity → App signing** and copy the **SHA-256 certificate fingerprint** of the *app signing key*.
   2. Set it as `ANDROID_CERT_SHA256` on Railway, and redeploy.
   3. Check that `https://<your site>/.well-known/assetlinks.json` shows it.
5. **Internal testing:** Test and release → Testing → Internal testing → create a release → upload the `.aab` → add testers' emails → share the opt-in link. Testers install from the Play Store.
6. **Closed testing** (personal accounts): the same steps with at least 12 testers, kept opted in for 14 days.
7. **Production:** promote the release, set countries to **India** (or more), and submit for review. Reviews usually take a few hours to a few days.

**When `www.sharedeals.in` works**, switch the app to it before your production release:
1. Set `server.url` in `capacitor.config.json` to `https://www.sharedeals.in`.
2. Update the **Try again** link in `www/offline.html` to match.
3. Change `PUBLIC_URL` on Railway, and update the redirect URIs registered with Google and Facebook.
4. Raise `versionCode`, then run `npx cap sync android` and build a new `.aab`.

Users are signed out once by the change of address.

## 7. Updating the app later

- **Website or server changes:** just deploy to Railway. The app shows them straight away.
- **Changes in `mobile/`** (icons, config, Capacitor/plugin upgrades, Android settings): raise `versionCode`, then `npx cap sync android`, build a signed `.aab`, and upload it as a new release.
- **Keeping up with Google Play:** each year Google raises the minimum target API level. Upgrade Capacitor (`npm i @capacitor/core@latest @capacitor/cli@latest @capacitor/android@latest` plus the plugins) and raise `targetSdkVersion` in `android/variables.gradle` when Play Console asks.

## iOS later

`npx cap add ios` creates the iOS project from the same config. iOS also needs:
- **Sign in with Apple:** Apple requires it alongside Google and Facebook.
- **Universal Links:** an `apple-app-site-association` file on the server.
- **User blocking:** an Apple requirement for apps where users post content.
- An Apple Developer account (US$99/year), and a Mac with Xcode to build.

Everything else (sign-in hand-off, account deletion, share, deep-link handling) is already platform-neutral.
