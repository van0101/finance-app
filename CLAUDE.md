# Finance: repo rules

Two apps, one version, one codebase:
- Web PWA (index.html, styles.css, app.js, db.js, import.js, sw.js, manifest.webmanifest, icons/) served by
  GitHub Pages from `main` at https://van0101.github.io/finance-app/.
- Android app in `android/` (Java, no AndroidX, Gradle 8.14.3, AGP in android/build.gradle): a WebView that
  bundles the web files at build time (`copyWeb` task in android/app/build.gradle) and serves them from
  https://appassets.androidplatform.net/www/. Don't copy web files into android/ by hand.
  Its versionName/versionCode are read from `APP_VERSION` in app.js; don't set them by hand.

## How it works
- No backend and no network calls. All transactions live on the device (IndexedDB via db.js).
- The app does not call any AI. The Import screen shows a prompt (buildPrompt in import.js) that the user
  copies into their own AI chat with statements/screenshots; the chat returns an .xlsx (or CSV/table text)
  with the columns in COLUMNS. If you change the columns, change buildPrompt and HEADERS together.
- import.js reads .xlsx itself (zip via DecompressionStream + DOMParser, no library), CSV/TSV and pasted
  markdown tables, finds the header row, and maps columns by name (HEADERS). Dates are day-first.
- Imported labels are only suggestions. Rows go to a review screen and are saved only when the user taps "Add to ledger".
  Never change saved records without a user action. Bulk relabels are offered as a button, never applied silently.
- Merchant -> label memory is written only from the user's own label choices, and only affects new imports.

## Every change that ships to users
1. Bump the version using semver: MAJOR for breaking changes (removed feature, reset data),
   MINOR for new features, PATCH for fixes, security and wording. While the app is 0.x (proof of
   concept), breaking changes bump MINOR instead.
2. Set it in all four places: `APP_VERSION` in app.js, `VERSION` in sw.js (`finance-vX.Y.Z`),
   the `#ver` footer text in index.html, and a new top entry in CHANGELOG.md
   (Keep a Changelog format, with the compare link at the bottom).
3. CI (`.github/workflows/version-check.yml`) fails if these don't match or the version wasn't bumped.
4. Android changes count as shipping changes too (CI includes `android/` in the bump check).
5. Tagging is automatic: `.github/workflows/release.yml` creates the `vX.Y.Z` tag and GitHub Release from the CHANGELOG section.

## Android builds
- `.github/workflows/android.yml` compiles on every push touching android/ or the web files.
- `.github/workflows/release.yml` builds the signed APK and attaches `finance.apk` to the release (Obtainium picks it up).
  Signing uses repo secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` (key alias `finance`).
  Never commit a keystore.
- Build logs aren't readable from Claude sessions; failures are surfaced as a run annotation.

## Conventions
- App name is "Finance".
- Keep the Content Security Policy: no inline scripts, styles or event handlers, and no outside hosts
  (connect-src 'self'). Don't add CDNs; vendor anything needed into the repo.
- No innerHTML with user or file text: build DOM with the `h()` helper in app.js.
- Never commit personal financial data (statements, exports, the spreadsheet). The repo is public.
- New files the web app needs offline must be added to `SHELL` in sw.js, and to the include list of
  `copyWeb` in android/app/build.gradle if they're not *.js, *.css or under icons/.
