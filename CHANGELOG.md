# Changelog

All notable changes to Finance are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the app uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **MAJOR** (2.0.0): a change that breaks how people use the app, such as removing a feature or resetting saved data.
- **MINOR** (1.2.0): a new feature that keeps everything else working.
- **PATCH** (1.1.1): bug fixes, security fixes, wording changes.

## [Unreleased]

## [0.1.0] - 2026-11-03

### Added
- First proof of concept.
- Connect one AI with your own API key: Claude (Anthropic), ChatGPT (OpenAI) or Gemini (Google). Three-step setup: pick the AI, get a key, paste and test it. The model list comes from the provider, with a sensible default preselected.
- Import bank or card statement PDFs and screenshots (several at once, or paste). The AI lists each transaction with date, name, merchant, amount, debit/credit, type and a suggested label.
- Review screen: nothing is saved until you tap "Add to ledger". Rows that match transactions already in your ledger are flagged and left unticked. Non-financial files are rejected with a note. Password-protected PDFs are caught with instructions.
- Labels: tap any label to pick from your list or type a new one. Changes save straight away and new labels appear in the dropdown from then on. Seeded with the categories from the FY 2026-27 spreadsheet.
- Learns from you: once you label a merchant, its next imports get the same label. Existing records never change unless you tap "Label all" or accept the offer to relabel the others.
- Ledger with search, month and label filters, money in/out totals, spend by label, and a grouped-by-merchant view.
- Label management (add, rename everywhere, delete unused) and a list of learned merchants you can forget.
- Export to CSV (same columns as the spreadsheet), backup and restore as JSON, delete all data.
- Android app: the same web app bundled in a WebView, with the system file picker and "Save as" for exports. Released as `finance.apk` for Obtainium.
- CI: version check, release with signed APK, Android build, CodeQL, ZAP baseline, Dependabot.

[Unreleased]: https://github.com/van0101/finance-app/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/van0101/finance-app/releases/tag/v0.1.0
