#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_TAG="${1:-signalforge-agent:local}"
IMAGE_PLATFORM="${SIGNALFORGE_IMAGE_PLATFORM:-}"
TARGET_ARCH=""

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the reference signalforge-agent image." >&2
  exit 1
fi

if [[ -n "$IMAGE_PLATFORM" ]]; then
  TARGET_ARCH="${IMAGE_PLATFORM##*/}"
fi

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT
"$AGENT_DIR/scripts/stage-container-build-context.sh" "$BUILD_ROOT" >/dev/null

build_args=(
  build
  -f "$BUILD_ROOT/contrib/container/Dockerfile"
  -t "$IMAGE_TAG"
)

if [[ -n "$IMAGE_PLATFORM" ]]; then
  build_args+=(--platform "$IMAGE_PLATFORM")
fi

if [[ -n "$TARGET_ARCH" ]]; then
  build_args+=(--build-arg "TARGETARCH=$TARGET_ARCH")
fi

build_args+=("$BUILD_ROOT")

docker "${build_args[@]}"

echo "Built $IMAGE_TAG"
