#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEM_TEMPLATE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.service"
SYSTEM_RUNTIME_HOST_TEMPLATE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.runtime-host.service"
USER_TEMPLATE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.user.service"
USER_RUNTIME_HOST_TEMPLATE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.user.runtime-host.service"
ENV_EXAMPLE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.env.example"
ENV_SOURCE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.env"
TOKEN_EXAMPLE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.token.example"
TOKEN_SOURCE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.token"
KUBECONFIG_SOURCE_PATH="$REPO_DIR/contrib/systemd/signalforge-agent.kubeconfig"

SERVICE_NAME="signalforge-agent"
SERVICE_SCOPE="system"
AGENT_USER="${SUDO_USER:-$(id -un)}"
WORKDIR="$REPO_DIR"
BUN_BIN=""
SERVICE_PROFILE="standard"
DRY_RUN=0

service_target_path() {
  local service_name="$1"
  if [[ "$SERVICE_SCOPE" == "user" ]]; then
    printf '%s/.config/systemd/user/%s.service' "$HOME" "$service_name"
  else
    printf '/etc/systemd/system/%s.service' "$service_name"
  fi
}

env_target_path() {
  local service_name="$1"
  if [[ "$SERVICE_SCOPE" == "user" ]]; then
    printf '%s/.config/signalforge-agent/%s.env' "$HOME" "$service_name"
  else
    printf '/etc/%s.env' "$service_name"
  fi
}

token_target_path() {
  local service_name="$1"
  if [[ "$SERVICE_SCOPE" == "user" ]]; then
    printf '%s/.config/signalforge-agent/%s.token' "$HOME" "$service_name"
  else
    printf '/etc/%s/token' "$service_name"
  fi
}

kubeconfig_target_path() {
  local service_name="$1"
  if [[ "$SERVICE_SCOPE" == "user" ]]; then
    printf '%s/.config/signalforge-agent/%s.kubeconfig' "$HOME" "$service_name"
  else
    printf '/etc/%s/kubeconfig' "$service_name"
  fi
}

SERVICE_TARGET_PATH="$(service_target_path "$SERVICE_NAME")"
ENV_TARGET_PATH="$(env_target_path "$SERVICE_NAME")"
TOKEN_TARGET_PATH="$(token_target_path "$SERVICE_NAME")"
KUBECONFIG_TARGET_PATH="$(kubeconfig_target_path "$SERVICE_NAME")"
TEMPLATE_PATH="$SYSTEM_TEMPLATE_PATH"

usage() {
  cat <<EOF
Usage:
  ./scripts/install-systemd-service.sh [options]

Options:
  --scope <system|user>  install a root-managed system unit or a user-systemd unit
                         (default: ${SERVICE_SCOPE})
  --user <name>          runtime user for the system unit (default: ${AGENT_USER})
  --workdir <path>       signalforge-agent checkout path (default: ${WORKDIR})
  --env-source <path>    repo-local env file to install (default: ${ENV_SOURCE_PATH})
  --env-target <path>    installed env file path (default: ${ENV_TARGET_PATH})
  --token-source <path>  repo-local token file to install (default: ${TOKEN_SOURCE_PATH})
  --token-target <path>  installed token file path (default: ${TOKEN_TARGET_PATH})
  --kubeconfig-source <path> optional repo-local kubeconfig to install (default: ${KUBECONFIG_SOURCE_PATH})
  --kubeconfig-target <path> installed kubeconfig path (default: ${KUBECONFIG_TARGET_PATH})
  --service-name <name>  systemd unit name without .service (default: ${SERVICE_NAME})
  --service-profile <profile>
                         service hardening profile: standard | runtime-host
                         (default: ${SERVICE_PROFILE})
  --bun <path>           absolute bun binary path (default: auto-detect)
  --dry-run              render into a temporary staging root and skip systemctl
  --help                 show this help

Workflow:
  1. Copy ${ENV_EXAMPLE_PATH} to ${ENV_SOURCE_PATH}
  2. Fill in the token and paths once
  3. Run this installer with sudo for --scope system, or as the target user for --scope user
EOF
}

refresh_paths() {
  SERVICE_TARGET_PATH="$(service_target_path "$SERVICE_NAME")"
  ENV_TARGET_PATH="$(env_target_path "$SERVICE_NAME")"
  TOKEN_TARGET_PATH="$(token_target_path "$SERVICE_NAME")"
  KUBECONFIG_TARGET_PATH="$(kubeconfig_target_path "$SERVICE_NAME")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SERVICE_SCOPE="$2"
      refresh_paths
      shift 2
      ;;
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
    --kubeconfig-source)
      KUBECONFIG_SOURCE_PATH="$2"
      shift 2
      ;;
    --kubeconfig-target)
      KUBECONFIG_TARGET_PATH="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      refresh_paths
      shift 2
      ;;
    --service-profile)
      SERVICE_PROFILE="$2"
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

case "$SERVICE_SCOPE" in
  system|user)
    ;;
  *)
    echo "Unsupported service scope: ${SERVICE_SCOPE}" >&2
    echo "Use one of: system, user" >&2
    exit 1
    ;;
esac

case "${SERVICE_SCOPE}:${SERVICE_PROFILE}" in
  system:standard)
    TEMPLATE_PATH="$SYSTEM_TEMPLATE_PATH"
    ;;
  system:runtime-host)
    TEMPLATE_PATH="$SYSTEM_RUNTIME_HOST_TEMPLATE_PATH"
    ;;
  user:standard)
    TEMPLATE_PATH="$USER_TEMPLATE_PATH"
    ;;
  user:runtime-host)
    TEMPLATE_PATH="$USER_RUNTIME_HOST_TEMPLATE_PATH"
    ;;
  *)
    echo "Unsupported service profile for scope ${SERVICE_SCOPE}: ${SERVICE_PROFILE}" >&2
    echo "Use profile standard or runtime-host" >&2
    exit 1
    ;;
esac

if [[ "$DRY_RUN" -eq 1 ]]; then
  STAGING_ROOT="$(mktemp -d)"
  trap 'rm -rf "$STAGING_ROOT"' EXIT
  SERVICE_TARGET_PATH="${STAGING_ROOT}${SERVICE_TARGET_PATH}"
  ENV_TARGET_PATH="${STAGING_ROOT}${ENV_TARGET_PATH}"
  TOKEN_TARGET_PATH="${STAGING_ROOT}${TOKEN_TARGET_PATH}"
  KUBECONFIG_TARGET_PATH="${STAGING_ROOT}${KUBECONFIG_TARGET_PATH}"
fi

if [[ "$DRY_RUN" -ne 1 && "$SERVICE_SCOPE" == "system" && "$(id -u)" -ne 0 ]]; then
  echo "Run as root for --scope system, for example: sudo ./scripts/install-systemd-service.sh" >&2
  exit 1
fi

if [[ "$DRY_RUN" -ne 1 && "$SERVICE_SCOPE" == "user" && -n "${SUDO_USER:-}" ]]; then
  echo "Run --scope user as the target login user, not through sudo." >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Missing service template: $TEMPLATE_PATH" >&2
  exit 1
fi

if [[ -z "$BUN_BIN" ]]; then
  if [[ "$SERVICE_SCOPE" == "system" && -n "${SUDO_USER:-}" ]]; then
    BUN_BIN="$(su - "$SUDO_USER" -c 'command -v bun' 2>/dev/null || true)"
  elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  fi
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
  SIGNALFORGE_AGENT_INSTANCE_ID
  SIGNALFORGE_COLLECTORS_DIR
)

if [[ -z "${SIGNALFORGE_BASE_URL:-}" && -z "${SIGNALFORGE_URL:-}" ]]; then
  echo "Missing required value in ${ENV_SOURCE_PATH}: SIGNALFORGE_BASE_URL or SIGNALFORGE_URL" >&2
  exit 1
fi

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
mkdir -p "$(dirname "$KUBECONFIG_TARGET_PATH")"
if [[ -f "$KUBECONFIG_SOURCE_PATH" && -s "$KUBECONFIG_SOURCE_PATH" ]]; then
  grep -Ev '^[[:space:]]*(SIGNALFORGE_AGENT_TOKEN(_FILE)?|SIGNALFORGE_KUBECONFIG|KUBECONFIG)=' "$ENV_SOURCE_PATH" > "$ENV_TARGET_PATH"
else
  grep -Ev '^[[:space:]]*SIGNALFORGE_AGENT_TOKEN(_FILE)?=' "$ENV_SOURCE_PATH" > "$ENV_TARGET_PATH"
fi
chmod 600 "$ENV_TARGET_PATH"
printf '%s\n' "$TOKEN_VALUE" > "$TOKEN_TARGET_PATH"
chmod 600 "$TOKEN_TARGET_PATH"
if [[ -f "$KUBECONFIG_SOURCE_PATH" && -s "$KUBECONFIG_SOURCE_PATH" ]]; then
  install -m 600 "$KUBECONFIG_SOURCE_PATH" "$KUBECONFIG_TARGET_PATH"
  printf '\nSIGNALFORGE_KUBECONFIG=%s\n' "$KUBECONFIG_TARGET_PATH" >> "$ENV_TARGET_PATH"
fi

sed_args=(
  -e "s|__SIGNALFORGE_AGENT_WORKDIR__|${WORKDIR}|g"
  -e "s|__SIGNALFORGE_AGENT_ENV_FILE__|${ENV_TARGET_PATH}|g"
  -e "s|__SIGNALFORGE_AGENT_TOKEN_FILE__|${TOKEN_TARGET_PATH}|g"
  -e "s|__SIGNALFORGE_AGENT_BUN__|${BUN_BIN}|g"
)
if [[ "$SERVICE_SCOPE" == "system" ]]; then
  sed_args+=( -e "s|__SIGNALFORGE_AGENT_USER__|${AGENT_USER}|g" )
fi
sed "${sed_args[@]}" "$TEMPLATE_PATH" > "$SERVICE_TARGET_PATH"

chmod 644 "$SERVICE_TARGET_PATH"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run complete."
  echo "Rendered ${SERVICE_TARGET_PATH}"
  echo "Rendered ${ENV_TARGET_PATH}"
  echo "Rendered ${TOKEN_TARGET_PATH}"
  if [[ -f "$KUBECONFIG_TARGET_PATH" ]]; then
    echo "Rendered ${KUBECONFIG_TARGET_PATH}"
  fi
  exit 0
fi

if [[ "$SERVICE_SCOPE" == "user" ]]; then
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}"
  echo "Installed ${SERVICE_TARGET_PATH}"
  echo "Installed ${ENV_TARGET_PATH}"
  echo "Installed ${TOKEN_TARGET_PATH}"
  if [[ -f "$KUBECONFIG_TARGET_PATH" ]]; then
    echo "Installed ${KUBECONFIG_TARGET_PATH}"
  fi
  echo
  echo "Check status:"
  echo "  systemctl --user status ${SERVICE_NAME}"
  echo
  echo "Follow logs:"
  echo "  journalctl --user -u ${SERVICE_NAME} -f"
  echo
  echo "For reboot persistence without an active login session, enable linger once:"
  echo "  sudo loginctl enable-linger $(id -un)"
  exit 0
fi

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "Installed ${SERVICE_TARGET_PATH}"
echo "Installed ${ENV_TARGET_PATH}"
echo "Installed ${TOKEN_TARGET_PATH}"
if [[ -f "$KUBECONFIG_TARGET_PATH" ]]; then
  echo "Installed ${KUBECONFIG_TARGET_PATH}"
fi
echo
echo "Check status:"
echo "  systemctl status ${SERVICE_NAME}"
echo
echo "Follow logs:"
echo "  journalctl -u ${SERVICE_NAME} -f"
