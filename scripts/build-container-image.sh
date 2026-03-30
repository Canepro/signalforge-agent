#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$AGENT_DIR/.." && pwd)"
COLLECTORS_DIR="${SIGNALFORGE_COLLECTORS_REPO:-$WORKSPACE_DIR/signalforge-collectors}"
IMAGE_TAG="${1:-signalforge-agent:local}"
IMAGE_PLATFORM="${SIGNALFORGE_IMAGE_PLATFORM:-}"
TARGET_ARCH=""

if [[ ! -d "$COLLECTORS_DIR" ]]; then
  echo "Missing signalforge-collectors checkout at: $COLLECTORS_DIR" >&2
  echo "Set SIGNALFORGE_COLLECTORS_REPO to the sibling repo path, then rerun." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the reference signalforge-agent image." >&2
  exit 1
fi

if [[ -n "$IMAGE_PLATFORM" ]]; then
  TARGET_ARCH="${IMAGE_PLATFORM##*/}"
fi

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT
COLLECTORS_STAGE_DIR="$BUILD_ROOT/$(basename "$COLLECTORS_DIR")"

mkdir -p "$COLLECTORS_STAGE_DIR"

tar \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=contrib/systemd/signalforge-agent.env \
  --exclude=contrib/systemd/signalforge-agent.token \
  --exclude=contrib/systemd/signalforge-agent.kubeconfig \
  --exclude=contrib/container/signalforge-agent.container.env \
  --exclude=contrib/container/signalforge-agent.container.token \
  --exclude=contrib/container/signalforge-agent.container.kubeconfig \
  -C "$AGENT_DIR" \
  -cf - \
  . \
  | tar -C "$BUILD_ROOT" -xf -

tar \
  --exclude=node_modules \
  --exclude=.git \
  --exclude='*.env' \
  --exclude='*.token' \
  --exclude='*.kubeconfig' \
  -C "$COLLECTORS_DIR" \
  -cf - \
  . \
  | tar -C "$COLLECTORS_STAGE_DIR" -xf -

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
