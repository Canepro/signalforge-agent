#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  publish-kubernetes-image.sh --registry <acr-name> --image <repo:tag> [options]

Build the SignalForge agent image in Azure Container Registry so Kubernetes targets
do not depend on local cross-architecture emulation.

Required:
  --registry <name>        Azure Container Registry name, for example: caneprophacr01
  --image <repo:tag>       Repository and tag inside the registry, for example:
                           signalforge-agent:oke-arm64-20260330

Options:
  --platform <os/arch>     Target image platform. Default: linux/arm64
  --file <path>            Dockerfile path relative to the staged build root.
                           Default: contrib/container/Dockerfile
  --timeout <seconds>      ACR build timeout. Default: 3600
  --no-wait                Queue the build and return immediately
  --help                   Show this help text
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$AGENT_DIR/.." && pwd)"
COLLECTORS_DIR="${SIGNALFORGE_COLLECTORS_REPO:-$WORKSPACE_DIR/signalforge-collectors}"

REGISTRY_NAME=""
IMAGE_REPO_TAG=""
IMAGE_PLATFORM="${SIGNALFORGE_IMAGE_PLATFORM:-linux/arm64}"
DOCKERFILE_PATH="contrib/container/Dockerfile"
BUILD_TIMEOUT="3600"
NO_WAIT="false"
TARGET_ARCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)
      REGISTRY_NAME="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE_REPO_TAG="${2:-}"
      shift 2
      ;;
    --platform)
      IMAGE_PLATFORM="${2:-}"
      shift 2
      ;;
    --file)
      DOCKERFILE_PATH="${2:-}"
      shift 2
      ;;
    --timeout)
      BUILD_TIMEOUT="${2:-}"
      shift 2
      ;;
    --no-wait)
      NO_WAIT="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$IMAGE_PLATFORM" ]]; then
  TARGET_ARCH="${IMAGE_PLATFORM##*/}"
fi

if [[ -z "$REGISTRY_NAME" || -z "$IMAGE_REPO_TAG" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -d "$COLLECTORS_DIR" ]]; then
  echo "Missing signalforge-collectors checkout at: $COLLECTORS_DIR" >&2
  echo "Set SIGNALFORGE_COLLECTORS_REPO to the sibling repo path, then rerun." >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required for remote ACR builds." >&2
  exit 1
fi

AZ_BIN="$(command -v az)"

BUILD_ROOT_BASE=""
if [[ "$AZ_BIN" == /mnt/* ]] && [[ -n "${TEMP:-}" ]] && [[ -d "${TEMP}" ]]; then
  BUILD_ROOT_BASE="${TEMP}"
fi

if [[ -n "$BUILD_ROOT_BASE" ]]; then
  BUILD_ROOT="$(mktemp -d -p "$BUILD_ROOT_BASE" signalforge-agent-build.XXXXXX)"
else
  BUILD_ROOT="$(mktemp -d)"
fi

trap 'rm -rf "$BUILD_ROOT"' EXIT
AGENT_STAGE_DIR="$BUILD_ROOT/$(basename "$AGENT_DIR")"
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

BUILD_SOURCE="$BUILD_ROOT"
DOCKERFILE_ARG="$DOCKERFILE_PATH"
if [[ "$AZ_BIN" == /mnt/* ]] && command -v wslpath >/dev/null 2>&1; then
  cp "$BUILD_ROOT/$DOCKERFILE_PATH" "$BUILD_ROOT/Dockerfile"
  BUILD_SOURCE="$(wslpath -w "$BUILD_ROOT")"
  DOCKERFILE_ARG="$(wslpath -w "$BUILD_ROOT/Dockerfile")"
fi

build_args=(
  acr build
  --registry "$REGISTRY_NAME"
  --image "$IMAGE_REPO_TAG"
  --platform "$IMAGE_PLATFORM"
  --file "$DOCKERFILE_ARG"
  --timeout "$BUILD_TIMEOUT"
)

if [[ -n "$TARGET_ARCH" ]]; then
  build_args+=(--build-arg "TARGETARCH=$TARGET_ARCH")
fi

if [[ "$NO_WAIT" == "true" ]]; then
  build_args+=(--no-wait)
fi

build_args+=("$BUILD_SOURCE")

az "${build_args[@]}"

REGISTRY_SERVER="$(az acr show --name "$REGISTRY_NAME" --query loginServer -o tsv | tr -d '\r')"
echo "Published image: ${REGISTRY_SERVER}/${IMAGE_REPO_TAG}"
