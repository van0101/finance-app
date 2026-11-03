# Finance

Transaction and finance tracker. Add bank or card statements (PDF) and payment screenshots, and the AI you
connect (Claude, ChatGPT or Gemini) lists every transaction. You label each one; the app remembers your labels
for next time.

- **Android app:** `finance.apk` on the [latest release](https://github.com/van0101/finance-app/releases/latest). Best installed with Obtainium so updates arrive by themselves.
- **Web app (PWA):** https://van0101.github.io/finance-app/

Everything stays on your device: there's no server. Files go only to the AI provider you connected, with your own API key.

## Install with Obtainium (Android)
1. Open Obtainium > **Add app**.
2. App source URL: `https://github.com/van0101/finance-app` > **Add**.
3. Tap **Install**. Allow Obtainium to install unknown apps if Android asks.
4. New releases show up in Obtainium's update list.

## Connect an AI
Settings > Connect AI, then follow the three steps. You need an **API key**, which is separate from a
chat subscription:

| AI | Get a key | Billing |
|---|---|---|
| Claude | https://console.anthropic.com/settings/keys | Prepaid credit in the Anthropic Console (Claude Pro/Max doesn't include API use) |
| ChatGPT | https://platform.openai.com/api-keys | Prepaid credit on platform.openai.com (ChatGPT Plus doesn't include API use) |
| Gemini | https://aistudio.google.com/apikey | Free tier available; on the free tier Google may use your inputs to improve its products |

## Using it
1. **Import**: add PDFs or screenshots, tap **Read transactions**.
2. **Review**: check the rows, change any label, untick anything you don't want. Possible duplicates are unticked for you.
3. **Add to ledger**. From then on, tap a label to change it; it saves immediately.

Password-protected PDFs (most Indian bank e-statements) can't be read yet: open the PDF, Print > Save as PDF
to get an unlocked copy, or use screenshots.

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
