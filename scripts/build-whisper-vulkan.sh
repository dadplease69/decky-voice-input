#!/usr/bin/env bash
# GPU (Vulkan) build of whisper-server for Steam Deck -> ./bin/whisper-server-vulkan
# Run ON the Deck (podman is preinstalled):  bash scripts/build-whisper-vulkan.sh
# The container image is picked so its glibc is not newer than the host's.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${WHISPER_REF:-master}"
ENGINE="${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}"
[ -n "$ENGINE" ] || { echo "Нужен podman или docker" >&2; exit 1; }

HOST_GLIBC="$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')"
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
if ver_ge "$HOST_GLIBC" "2.39"; then IMAGE="docker.io/library/ubuntu:24.04"; else IMAGE="docker.io/library/debian:bookworm"; fi
echo "host glibc $HOST_GLIBC -> $IMAGE"

mkdir -p "$ROOT/bin"
"$ENGINE" run --rm -v "$ROOT:/work:Z" "$IMAGE" bash -euxc "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq build-essential cmake git ca-certificates libvulkan-dev glslc glslang-tools >/dev/null
  # Fresh Vulkan + SPIR-V headers from Khronos (distro ones are too old / lack CMake config)
  for repo in Vulkan-Headers SPIRV-Headers; do
    rm -rf /tmp/\$repo
    git clone --depth 1 https://github.com/KhronosGroup/\$repo /tmp/\$repo
    cmake -S /tmp/\$repo -B /tmp/\$repo/build -DCMAKE_INSTALL_PREFIX=/usr/local >/dev/null
    cmake --install /tmp/\$repo/build >/dev/null
  done
  rm -rf /tmp/w && git clone --depth 1 --branch '$REF' https://github.com/ggml-org/whisper.cpp /tmp/w
  cmake -S /tmp/w -B /tmp/w/build -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF \
    -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
    -DGGML_VULKAN=ON -DVulkan_INCLUDE_DIR=/usr/local/include -DCMAKE_PREFIX_PATH=/usr/local \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    -DCMAKE_EXE_LINKER_FLAGS='-static-libgcc -static-libstdc++'
  cmake --build /tmp/w/build -j\$(nproc) --target whisper-server
  install -m 755 /tmp/w/build/bin/whisper-server /work/bin/whisper-server-vulkan
  cp /tmp/w/LICENSE /work/bin/LICENSE-whisper.cpp
"
echo "--- проверка зависимостей на хосте:"
ldd "$ROOT/bin/whisper-server-vulkan" | grep -E "not found|vulkan|libc.so" || true
echo "Готово: $ROOT/bin/whisper-server-vulkan"
