#!/usr/bin/env bash
# Local build of bin/whisper-server for Steam Deck (x86_64, Zen 2) in a container.
# Works with podman (preinstalled on SteamOS) or docker. CI does the same in release.yml.
#   ./scripts/build-whisper.sh
#   WHISPER_REF=v1.7.6 ./scripts/build-whisper.sh
# Debian bookworm is used on purpose: its glibc is older than SteamOS's.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${WHISPER_REF:-master}"
ENGINE="${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}"
[ -n "$ENGINE" ] || { echo "Нужен podman или docker" >&2; exit 1; }

"$ENGINE" run --rm -v "$ROOT:/work:Z" docker.io/library/debian:bookworm bash -euc "
  apt-get update -qq && apt-get install -y -qq build-essential cmake git ca-certificates >/dev/null
  bash /work/scripts/build-whisper-inner.sh '$REF' /work/bin
"
echo "Готово: $ROOT/bin/whisper-server ($(cat "$ROOT/bin/whisper.cpp.version"))"
