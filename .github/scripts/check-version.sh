#!/usr/bin/env bash
# Fails the build when:
#  1. the version differs between app.js, sw.js, index.html and the top CHANGELOG entry, or
#  2. app files changed in the last commit but the version was not bumped (semver, must go up).
set -euo pipefail

SEMVER='[0-9]+\.[0-9]+\.[0-9]+'
app_version() { grep -oE "APP_VERSION = \"$SEMVER\"" | grep -oE "$SEMVER"; }

app=$(app_version < app.js)
sw=$(grep -oE "finance-v$SEMVER" sw.js | grep -oE "$SEMVER")
html=$(grep -oE "id=\"ver\">v$SEMVER" index.html | grep -oE "$SEMVER")
log=$(grep -m1 -oE "^## \[$SEMVER\]" CHANGELOG.md | grep -oE "$SEMVER")

echo "app.js=$app  sw.js=$sw  index.html=$html  CHANGELOG.md=$log"
if [[ "$app" != "$sw" || "$app" != "$html" || "$app" != "$log" ]]; then
  echo "::error::Version numbers don't match. Set the same version in app.js (APP_VERSION), sw.js (VERSION), index.html (#ver) and add it as the top entry in CHANGELOG.md."
  exit 1
fi

if git rev-parse -q --verify HEAD~1 >/dev/null; then
  changed=$(git diff --name-only HEAD~1 HEAD -- index.html app.js db.js llm.js styles.css sw.js manifest.webmanifest icons android)
  if [[ -n "$changed" ]]; then
    prev=$(git show HEAD~1:app.js 2>/dev/null | app_version || true)
    echo "App files changed: $(echo "$changed" | tr '\n' ' ')"
    echo "Previous version: ${prev:-none}"
    if [[ -n "$prev" ]]; then
      if [[ "$prev" == "$app" ]]; then
        echo "::error::App files changed but the version is still $app. Bump it (semver) and add a CHANGELOG entry."
        exit 1
      fi
      highest=$(printf '%s\n%s\n' "$prev" "$app" | sort -V | tail -1)
      if [[ "$highest" != "$app" ]]; then
        echo "::error::Version went down from $prev to $app. Versions must only go up."
        exit 1
      fi
    fi
  fi
fi
echo "Version check passed: $app"
