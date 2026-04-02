#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  publish-kubernetes-image.sh --registry <acr-name> --image <repo:tag> [options]

Optional Azure helper: build the SignalForge agent image in Azure Container Registry so Kubernetes targets
do not depend on local cross-architecture emulation.

Required:
  --registry <name>        Azure Container Registry name
  --image <repo:tag>       Repository and tag inside the registry, for example:
                           signalforge-agent:kubernetes-arm64-20260401

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

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required for the optional remote ACR build path." >&2
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
"$AGENT_DIR/scripts/stage-container-build-context.sh" "$BUILD_ROOT" >/dev/null

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
