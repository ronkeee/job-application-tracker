#!/bin/bash
# Run every couple of days to pull latest Gmail data
# Usage: ./refresh.sh
cd "$(dirname "$0")"
bun gmail_fetcher.js
echo ""
echo "Open tracker/website/index.html in your browser (or run: python3 -m http.server 8080 inside website/)"
