#!/usr/bin/env bash
# Packs an installable plugin zip in the layout Decky expects:
#   decky-voice-input/{plugin.json,package.json,main.py,py_modules,dist,bin,LICENSE,README.md}
# Run after `pnpm run build` (dist/) and with engine binaries in bin/ (see release.yml).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NAME="decky-voice-input"
[ -f dist/index.js ] || { echo "dist/index.js missing — run pnpm run build" >&2; exit 1; }
ls bin/whisper-server-* >/dev/null 2>&1 || echo "warning: no engine binaries in bin/" >&2

rm -rf out && mkdir -p "out/$NAME"
cp -r plugin.json package.json main.py py_modules dist LICENSE README.md "out/$NAME/"
[ -d bin ] && cp -r bin "out/$NAME/"
find "out/$NAME" -name '__pycache__' -prune -exec rm -rf {} +
(cd out && python3 -m zipfile -c "$NAME.zip" "$NAME")
echo "out/$NAME.zip  sha256=$(sha256sum "out/$NAME.zip" | cut -d' ' -f1)"
