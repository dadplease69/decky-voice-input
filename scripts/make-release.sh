#!/usr/bin/env bash
# Packs the plugin zip and regenerates store/store.json (a Decky "Custom" store feed).
#   ./scripts/make-release.sh
# Then: create GitHub release v<version>, attach out/decky-voice-input.zip,
# commit store/store.json. In Decky: Settings → General → Store channel: Custom,
# store URL = raw URL of store/store.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NAME="decky-voice-input"
REPO="${REPO:-dadplease69/decky-voice-input}"
VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"


rm -rf out && mkdir -p "out/$NAME"
cp -r plugin.json package.json main.py py_modules dist LICENSE README.md "out/$NAME/"
find "out/$NAME" -name '__pycache__' -prune -exec rm -rf {} +
(cd out && rm -f "$NAME.zip" && python3 -m zipfile -c "$NAME.zip" "$NAME")

HASH="$(sha256sum "out/$NAME.zip" | cut -d' ' -f1)"
python3 - "$VERSION" "$HASH" "$REPO" <<'PY'
import json, sys
version, sha, repo = sys.argv[1:4]
meta = json.load(open("plugin.json"))
feed = [{
    "id": 990001,
    "name": meta["name"],
    "author": meta["author"],
    "description": meta["publish"]["description"],
    "tags": meta["publish"]["tags"],
    "image_url": meta["publish"]["image"],
    "versions": [{
        "name": version,
        "hash": sha,
        "artifact": f"https://github.com/{repo}/releases/download/v{version}/decky-voice-input.zip",
    }],
}]
json.dump(feed, open("store/store.json", "w"), ensure_ascii=False, indent=2)
PY
echo "out/$NAME.zip  sha256=$HASH  version=$VERSION"
echo "Store URL: https://raw.githubusercontent.com/$REPO/main/store/store.json"
