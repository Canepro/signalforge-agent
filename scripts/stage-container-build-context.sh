#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  stage-container-build-context.sh <output-dir>

Create a Docker build context that contains:

- the signalforge-agent repo at the context root
- a sibling signalforge-collectors checkout staged into ./signalforge-collectors

The collectors repo path defaults to ../signalforge-collectors relative to this repo.
Override it with SIGNALFORGE_COLLECTORS_REPO when needed.
EOF
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$AGENT_DIR/.." && pwd)"
COLLECTORS_DIR="${SIGNALFORGE_COLLECTORS_REPO:-$WORKSPACE_DIR/signalforge-collectors}"
OUTPUT_DIR="$1"

if [[ ! -d "$COLLECTORS_DIR" ]]; then
  echo "Missing signalforge-collectors checkout at: $COLLECTORS_DIR" >&2
  echo "Set SIGNALFORGE_COLLECTORS_REPO to the collectors repo path, then rerun." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
COLLECTORS_STAGE_DIR="$OUTPUT_DIR/signalforge-collectors"
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
  | tar -C "$OUTPUT_DIR" -xf -

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

printf '%s\n' "$OUTPUT_DIR"
