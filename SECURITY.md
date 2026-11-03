# Security

Finance is a static web page plus an Android WebView wrapper. There's no backend and no login.

## Where data goes
- Transactions and labels are stored on the device only (IndexedDB). Android backup is off.
- The app makes no network calls: the CSP allows only the app's own files (`connect-src 'self'`).
- Imported spreadsheets are read on the device. The statements themselves go only to whichever AI chat you
  choose to paste them into, outside this app, under that service's own terms.

## Checks in this repo
| Check | What it catches | Where to see results |
|---|---|---|
| CodeQL (`.github/workflows/codeql.yml`) | Risky code patterns in JS, Android Java and the workflows | Security > Code scanning |
| ZAP baseline (`.github/workflows/zap-baseline.yml`) | Header and config issues on the live site | Actions > ZAP run > Artifacts |
| Version check (`.github/workflows/version-check.yml`) | Releases that skip the version bump or changelog entry | Actions |
| Dependabot (`.github/dependabot.yml`) | Outdated GitHub Actions | Pull requests |

## Hardening in the app
- Content Security Policy (meta tag): scripts, styles and network only to this site, no plugins, no form posts.
- `referrer` set to `no-referrer`.
- No `eval`, and no imported or user text is written into the page as HTML.
- The .xlsx reader caps unzipped size (60 MB) and only unpacks the workbook, sheet and shared-string parts.
- CSV export escapes cells that start with `=`, `+`, `-` or `@` so spreadsheets don't run them as formulas.
- Android: no file:// access, external links open in the browser, only the app's own asset host is served inside the WebView.

## Android permissions
| Permission | Why |
|---|---|
| `INTERNET` | WebView needs it to load the app's own `https://appassets.androidplatform.net` page. The CSP blocks all outside hosts. |

The APK is signed with a key stored only in GitHub Actions secrets.

## Reporting
Open a private advisory: Security > Advisories > Report a vulnerability.
