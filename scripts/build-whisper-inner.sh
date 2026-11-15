#!/usr/bin/env bash
# Builds whisper-server inside a Debian/Ubuntu container (CI or local).
# Usage: VARIANT=cpu|vulkan build-whisper-inner.sh <whisper.cpp git ref> <output dir>
#   cpu    -> <out>/whisper-server-cpu     (Debian bookworm: old glibc, runs on any SteamOS 3.x)
#   vulkan -> <out>/whisper-server-vulkan  (Ubuntu 24.04: needs host glibc >= 2.39)
set -euxo pipefail
VARIANT="${VARIANT:-cpu}"
REF="$1"
OUT="$2"
SRC="${SRC_DIR:-/tmp/whisper.cpp}"
export DEBIAN_FRONTEND=noninteractive

PKGS="build-essential cmake git ca-certificates"
[ "$VARIANT" = vulkan ] && PKGS="$PKGS libvulkan-dev glslc glslang-tools"
apt-get update -qq
apt-get install -y -qq $PKGS >/dev/null

EXTRA=()
if [ "$VARIANT" = vulkan ]; then
  # Fresh Vulkan + SPIR-V headers (distro ones are too old / lack CMake config)
  for repo in Vulkan-Headers SPIRV-Headers; do
    rm -rf "/tmp/$repo"
    git clone --depth 1 "https://github.com/KhronosGroup/$repo" "/tmp/$repo"
    cmake -S "/tmp/$repo" -B "/tmp/$repo/build" -DCMAKE_INSTALL_PREFIX=/usr/local >/dev/null
    cmake --install "/tmp/$repo/build" >/dev/null
  done
  EXTRA=(-DGGML_VULKAN=ON -DVulkan_INCLUDE_DIR=/usr/local/include -DCMAKE_PREFIX_PATH=/usr/local)
fi

rm -rf "$SRC"
git clone --depth 1 --branch "$REF" https://github.com/ggml-org/whisper.cpp "$SRC"
cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF \
  -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DCMAKE_EXE_LINKER_FLAGS='-static-libgcc -static-libstdc++' "${EXTRA[@]}"
cmake --build "$SRC/build" -j"$(nproc)" --target whisper-server
mkdir -p "$OUT"
install -m 755 "$SRC/build/bin/whisper-server" "$OUT/whisper-server-$VARIANT"
cp "$SRC/LICENSE" "$OUT/LICENSE-whisper.cpp"
git -C "$SRC" rev-parse HEAD > "$OUT/whisper.cpp.version"
