#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.service"
ENV_EXAMPLE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.env.example"
ENV_SOURCE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.env"
TOKEN_EXAMPLE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.token.example"
TOKEN_SOURCE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.token"

SERVICE_NAME="signalforge-agent"
SERVICE_TARGET_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_TARGET_PATH="/etc/${SERVICE_NAME}.env"
TOKEN_TARGET_PATH="/etc/${SERVICE_NAME}/token"
AGENT_USER="${SUDO_USER:-$(id -un)}"
WORKDIR="$REPO_DIR"
BUN_BIN=""
DRY_RUN=0

usage() {
  cat <<EOF
Usage:
  sudo ./scripts/install-systemd-service.sh [options]

Options:
  --user <name>          system user for the service (default: ${AGENT_USER})
  --workdir <path>       signalforge-agent checkout path (default: ${WORKDIR})
  --env-source <path>    repo-local env file to install (default: ${ENV_SOURCE_PATH})
  --env-target <path>    installed env file path (default: ${ENV_TARGET_PATH})
  --token-source <path>  repo-local token file to install (default: ${TOKEN_SOURCE_PATH})
  --token-target <path>  installed token file path (default: ${TOKEN_TARGET_PATH})
  --service-name <name>  systemd unit name without .service (default: ${SERVICE_NAME})
  --bun <path>           absolute bun binary path (default: auto-detect)
  --dry-run              render into a temporary staging root and skip systemctl
  --help                 show this help

Workflow:
  1. Copy ${ENV_EXAMPLE_PATH} to ${ENV_SOURCE_PATH}
  2. Fill in the token and paths once
  3. Run this installer with sudo
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      AGENT_USER="$2"
      shift 2
      ;;
    --workdir)
      WORKDIR="$2"
      shift 2
      ;;
    --env-source)
      ENV_SOURCE_PATH="$2"
      shift 2
      ;;
    --env-target)
      ENV_TARGET_PATH="$2"
      shift 2
      ;;
    --token-source)
      TOKEN_SOURCE_PATH="$2"
      shift 2
      ;;
    --token-target)
      TOKEN_TARGET_PATH="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      SERVICE_TARGET_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
      ENV_TARGET_PATH="/etc/${SERVICE_NAME}.env"
      TOKEN_TARGET_PATH="/etc/${SERVICE_NAME}/token"
      shift 2
      ;;
    --bun)
      BUN_BIN="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  STAGING_ROOT="$(mktemp -d)"
  SERVICE_TARGET_PATH="${STAGING_ROOT}/etc/systemd/system/${SERVICE_NAME}.service"
  ENV_TARGET_PATH="${STAGING_ROOT}/etc/${SERVICE_NAME}.env"
  TOKEN_TARGET_PATH="${STAGING_ROOT}/etc/${SERVICE_NAME}/token"
fi

if [[ "$DRY_RUN" -ne 1 && "$(id -u)" -ne 0 ]]; then
  echo "Run as root, for example: sudo ./scripts/install-systemd-service.sh" >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Missing service template: $TEMPLATE_PATH" >&2
  exit 1
fi

if [[ -z "$BUN_BIN" ]]; then
  if [[ -n "${SUDO_USER:-}" ]]; then
    BUN_BIN="$(su - "$SUDO_USER" -c 'command -v bun' 2>/dev/null || true)"
  fi
fi

if [[ -z "$BUN_BIN" ]] && command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
fi

if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "Could not find an executable bun binary. Re-run with --bun /absolute/path/to/bun" >&2
  exit 1
fi

if [[ ! -f "$ENV_SOURCE_PATH" ]]; then
  cp "$ENV_EXAMPLE_PATH" "$ENV_SOURCE_PATH"
  chmod 600 "$ENV_SOURCE_PATH"
  if [[ ! -f "$TOKEN_SOURCE_PATH" ]]; then
    cp "$TOKEN_EXAMPLE_PATH" "$TOKEN_SOURCE_PATH"
    chmod 600 "$TOKEN_SOURCE_PATH"
  fi
  echo "Created $ENV_SOURCE_PATH from example."
  echo "Created $TOKEN_SOURCE_PATH from example."
  echo "Fill in the token and confirm the paths, then rerun this installer."
  exit 0
fi

set -a
# shellcheck disable=SC1090
source "$ENV_SOURCE_PATH"
set +a

required_vars=(
  SIGNALFORGE_URL
  SIGNALFORGE_AGENT_INSTANCE_ID
  SIGNALFORGE_COLLECTORS_DIR
)

for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required value in ${ENV_SOURCE_PATH}: ${name}" >&2
    exit 1
  fi
done

TOKEN_VALUE=""
if [[ -f "$TOKEN_SOURCE_PATH" ]]; then
  TOKEN_VALUE="$(tr -d '\r' < "$TOKEN_SOURCE_PATH" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi
if [[ -z "$TOKEN_VALUE" && -n "${SIGNALFORGE_AGENT_TOKEN:-}" ]]; then
  TOKEN_VALUE="${SIGNALFORGE_AGENT_TOKEN}"
fi
if [[ -z "$TOKEN_VALUE" || "$TOKEN_VALUE" == "paste-enrollment-token-here" ]]; then
  echo "Missing source-bound token. Fill ${TOKEN_SOURCE_PATH} (preferred) or set SIGNALFORGE_AGENT_TOKEN in ${ENV_SOURCE_PATH}." >&2
  exit 1
fi

mkdir -p "$(dirname "$SERVICE_TARGET_PATH")" "$(dirname "$ENV_TARGET_PATH")" "$(dirname "$TOKEN_TARGET_PATH")"
grep -Ev '^[[:space:]]*SIGNALFORGE_AGENT_TOKEN(_FILE)?=' "$ENV_SOURCE_PATH" > "$ENV_TARGET_PATH"
chmod 600 "$ENV_TARGET_PATH"
printf '%s\n' "$TOKEN_VALUE" > "$TOKEN_TARGET_PATH"
chmod 600 "$TOKEN_TARGET_PATH"

sed \
  -e "s|__SIGNALFORGE_AGENT_USER__|${AGENT_USER}|g" \
  -e "s|__SIGNALFORGE_AGENT_WORKDIR__|${WORKDIR}|g" \
  -e "s|__SIGNALFORGE_AGENT_ENV_FILE__|${ENV_TARGET_PATH}|g" \
  -e "s|__SIGNALFORGE_AGENT_TOKEN_FILE__|${TOKEN_TARGET_PATH}|g" \
  -e "s|__SIGNALFORGE_AGENT_BUN__|${BUN_BIN}|g" \
  "$TEMPLATE_PATH" > "$SERVICE_TARGET_PATH"

chmod 644 "$SERVICE_TARGET_PATH"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run complete."
  echo "Rendered ${SERVICE_TARGET_PATH}"
  echo "Rendered ${ENV_TARGET_PATH}"
  echo "Rendered ${TOKEN_TARGET_PATH}"
  exit 0
fi

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "Installed ${SERVICE_TARGET_PATH}"
echo "Installed ${ENV_TARGET_PATH}"
echo "Installed ${TOKEN_TARGET_PATH}"
echo
echo "Check status:"
echo "  systemctl status ${SERVICE_NAME}"
echo
echo "Follow logs:"
echo "  journalctl -u ${SERVICE_NAME} -f"
