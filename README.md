# Finance

Transaction and finance tracker. Turn bank or card statements and payment screenshots into a spreadsheet with
any AI chat you already use (Claude, ChatGPT, Gemini), import it, and label each transaction. The app remembers
your labels for next time.

- **Android app:** `finance.apk` on the [latest release](https://github.com/van0101/finance-app/releases/latest). Best installed with Obtainium so updates arrive by themselves.
- **Web app (PWA):** https://van0101.github.io/finance-app/

Everything stays on your device. The app makes no network calls and has no server.

## Install with Obtainium (Android)
1. Open Obtainium > **Add app**.
2. App source URL: `https://github.com/van0101/finance-app` > **Add**.
3. Tap **Install**. Allow Obtainium to install unknown apps if Android asks.
4. New releases show up in Obtainium's update list.

## Using it
1. **Import > Copy the prompt** (tap the prompt box).
2. Open your AI chat app, paste the prompt and attach your statement PDFs or screenshots. It replies with
   `transactions.xlsx` (or a CSV table if it can't make files).
3. Back in Finance, **Import > Add the Excel or CSV file** and pick the downloaded file, or open
   **Or paste the table from the chat** and paste the table.
4. **Review**: change any label, untick anything you don't want. Rows already in your ledger are unticked for you.
5. **Add to ledger**. From then on, tap a label to change it; it saves immediately.

The prompt includes your labels and the merchant labels you've picked, so the AI's suggestions improve as you use the app.

Your own spreadsheets and bank exports also import, as long as they have a Date column and an Amount (or
Withdrawal/Deposit) column. Header names are matched automatically.

Expected columns: `Date | Name | Merchant | Description | Amount | Credit/Debit | Type | Label`

## Publish the web app with GitHub Pages
Repo > Settings > Pages > Source: "Deploy from a branch" > Branch: `main`, folder `/ (root)` > Save.

## Android signing
The release workflow signs the APK with the key in the repo secrets `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD` (alias `finance`). Keep a copy of the keystore: Android only installs updates signed with the same key.

## Versioning
[Semver](https://semver.org). The version shows at the bottom of the page; see [CHANGELOG.md](CHANGELOG.md).

## Updating
1. Change the web files (or `android/`).
2. Bump the version in app.js (`APP_VERSION`), sw.js (`VERSION`) and index.html (`#ver`).
3. Add an entry at the top of CHANGELOG.md.
4. Push. GitHub Actions tags the release, builds `finance.apk` and attaches it.
