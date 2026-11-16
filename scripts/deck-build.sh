#!/bin/bash
# Builds the frontend on the Steam Deck in a throwaway node container (used by dev-sync.ps1).
# Output: ~/vi-src/dist/index.js, log in ~/vi-src/build.log; prints the exit code.
cd "$HOME/vi-src" || exit 1
mkdir -p "$HOME/.cache/vi-pnpm"
podman run --rm -v "$HOME/vi-src:/w:Z" -v "$HOME/.cache/vi-pnpm:/pnpm:Z" -w /w \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 docker.io/library/node:22-slim \
  sh -c 'corepack enable && pnpm config set store-dir /pnpm/store >/dev/null && pnpm install --reporter=append-only && pnpm run build' \
  > build.log 2>&1
echo $?
