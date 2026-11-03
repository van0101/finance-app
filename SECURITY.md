# Security

Finance is a static web page plus an Android WebView wrapper. There's no backend and no login.

## Where data goes
- Transactions, labels and the API key are stored on the device only (IndexedDB). Android backup is off.
- Files you import are sent only to the AI provider you connected (api.anthropic.com, api.openai.com or
  generativelanguage.googleapis.com), using your own key. The CSP blocks every other host.
- On Gemini's free tier, Google may use inputs to improve its products. The setup screen says so.

## Checks in this repo
| Check | What it catches | Where to see results |
|---|---|---|
| CodeQL (`.github/workflows/codeql.yml`) | Risky code patterns in JS, Android Java and the workflows | Security > Code scanning |
| ZAP baseline (`.github/workflows/zap-baseline.yml`) | Header and config issues on the live site | Actions > ZAP run > Artifacts |
| Version check (`.github/workflows/version-check.yml`) | Releases that skip the version bump or changelog entry | Actions |
| Dependabot (`.github/dependabot.yml`) | Outdated GitHub Actions | Pull requests |

## Hardening in the app
- Content Security Policy (meta tag): scripts and styles only from this site, network only to the three AI hosts, no plugins, no form posts.
- `referrer` set to `no-referrer`.
- No `eval`, and no AI or user text is written into the page as HTML.
- CSV export escapes cells that start with `=`, `+`, `-` or `@` so spreadsheets don't run them as formulas.
- Android: no file:// access, external links open in the browser, only the app's own asset host is served inside the WebView.

## Android permissions
| Permission | Why |
|---|---|
| `INTERNET` | Calls to the AI provider you connected |

The APK is signed with a key stored only in GitHub Actions secrets.

## Reporting
Open a private advisory: Security > Advisories > Report a vulnerability.
