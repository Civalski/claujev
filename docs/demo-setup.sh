#!/usr/bin/env bash
# Throwaway repository for recording the demo: a local "remote", so nothing real is ever pushed.
set -euo pipefail
DEMO="${TMPDIR:-/tmp}/claujev-demo"
rm -rf "$DEMO" && mkdir -p "$DEMO"
git init -q --bare "$DEMO/remote.git"
git init -q -b main "$DEMO/app"
cd "$DEMO/app"
printf 'export const greet = (name) => `Hello, ${name}`;\n' > greet.js
git add . && git commit -q -m "first commit"
git remote add origin "$DEMO/remote.git" && git push -q origin main
echo "Demo repo ready: $DEMO/app"
