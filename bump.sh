#!/usr/bin/env bash
# Bump the ?v= stamp on app.js/style.css so a deploy can never serve a new
# index.html beside a cached script. Run before committing any JS/CSS change.
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M)
sed -i -E "s/(app\.js\?v=)[0-9]+/\1$V/; s/(style\.css\?v=)[0-9]+/\1$V/" index.html
echo "asset version -> $V"
