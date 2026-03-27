#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$AGENT_DIR/.." && pwd)"
COLLECTORS_DIR="${SIGNALFORGE_COLLECTORS_REPO:-$WORKSPACE_DIR/signalforge-collectors}"
IMAGE_TAG="${1:-signalforge-agent:local}"

if [[ ! -d "$COLLECTORS_DIR" ]]; then
  echo "Missing signalforge-collectors checkout at: $COLLECTORS_DIR" >&2
  echo "Set SIGNALFORGE_COLLECTORS_REPO to the sibling repo path, then rerun." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the reference signalforge-agent image." >&2
  exit 1
fi

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT

tar \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=contrib/systemd/signalforge-agent.env \
  --exclude=contrib/systemd/signalforge-agent.token \
  --exclude=contrib/systemd/signalforge-agent.kubeconfig \
  -C "$AGENT_DIR/.." \
  -cf - \
  "$(basename "$AGENT_DIR")" \
  "$(basename "$COLLECTORS_DIR")" \
  | tar -C "$BUILD_ROOT" -xf -

docker build \
  -f "$BUILD_ROOT/$(basename "$AGENT_DIR")/contrib/container/Dockerfile" \
  -t "$IMAGE_TAG" \
  "$BUILD_ROOT"

echo "Built $IMAGE_TAG"
