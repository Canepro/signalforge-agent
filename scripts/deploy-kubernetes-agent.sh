#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-kubernetes-agent.sh --image <registry/image:tag> --signalforge-url <url> [options]

Deploy or update the cluster-side SignalForge Kubernetes agent using the reference
manifest in contrib/kubernetes/deployment.yaml.

Required:
  --image <image>               Full image reference
  --signalforge-url <url>       Control-plane base URL

Authentication:
  --agent-token <token>         Agent enrollment token
  --agent-token-file <path>     File containing the agent enrollment token

Registry access:
  --acr-name <name>             Azure Container Registry name. When provided, the script
                                creates or updates an image pull secret from `az acr login --expose-token`.
  --pull-secret-name <name>     Pull secret name. Default: signalforge-agent-regcred
  --skip-pull-secret            Do not manage image pull credentials

Options:
  --namespace <name>            Kubernetes namespace. Default: signalforge
  --context <name>              kubectl context to target
  --kube-context-alias <name>   Extra kubeconfig context name to expose inside the pod,
                                for example: oke-cluster
  --deployment-name <name>      Deployment name. Default: signalforge-agent
  --help                        Show this help text
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_PATH="$AGENT_DIR/contrib/kubernetes/deployment.yaml"

NAMESPACE="signalforge"
DEPLOYMENT_NAME="signalforge-agent"
PULL_SECRET_NAME="signalforge-agent-regcred"
KUBE_CONTEXT=""
KUBE_CONTEXT_ALIAS=""
IMAGE=""
SIGNALFORGE_URL=""
AGENT_TOKEN=""
AGENT_TOKEN_FILE=""
ACR_NAME=""
SKIP_PULL_SECRET="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --signalforge-url)
      SIGNALFORGE_URL="${2:-}"
      shift 2
      ;;
    --agent-token)
      AGENT_TOKEN="${2:-}"
      shift 2
      ;;
    --agent-token-file)
      AGENT_TOKEN_FILE="${2:-}"
      shift 2
      ;;
    --acr-name)
      ACR_NAME="${2:-}"
      shift 2
      ;;
    --pull-secret-name)
      PULL_SECRET_NAME="${2:-}"
      shift 2
      ;;
    --skip-pull-secret)
      SKIP_PULL_SECRET="true"
      shift
      ;;
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --context)
      KUBE_CONTEXT="${2:-}"
      shift 2
      ;;
    --kube-context-alias)
      KUBE_CONTEXT_ALIAS="${2:-}"
      shift 2
      ;;
    --deployment-name)
      DEPLOYMENT_NAME="${2:-}"
      shift 2
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

if [[ -z "$IMAGE" || -z "$SIGNALFORGE_URL" ]]; then
  usage >&2
  exit 1
fi

if [[ -n "$AGENT_TOKEN" && -n "$AGENT_TOKEN_FILE" ]]; then
  echo "Set either --agent-token or --agent-token-file, not both." >&2
  exit 1
fi

if [[ -n "$AGENT_TOKEN_FILE" ]]; then
  if [[ ! -f "$AGENT_TOKEN_FILE" ]]; then
    echo "Token file not found: $AGENT_TOKEN_FILE" >&2
    exit 1
  fi
  AGENT_TOKEN="$(tr -d '\r' <"$AGENT_TOKEN_FILE")"
fi

if [[ -z "$AGENT_TOKEN" ]]; then
  echo "An agent token is required." >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required." >&2
  exit 1
fi

kubectl_args=()
if [[ -n "$KUBE_CONTEXT" ]]; then
  kubectl_args+=(--context "$KUBE_CONTEXT")
fi

rendered_kubeconfig="$(mktemp)"
rendered_manifest="$(mktemp)"
cleanup() {
  rm -f "$rendered_manifest" "$rendered_kubeconfig"
}
trap cleanup EXIT

{
  printf '%s\n' 'apiVersion: v1'
  printf '%s\n' 'kind: Config'
  printf '%s\n' 'clusters:'
  printf '%s\n' '  - name: in-cluster'
  printf '%s\n' '    cluster:'
  printf '%s\n' '      server: https://kubernetes.default.svc'
  printf '%s\n' '      certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
  printf '%s\n' 'contexts:'
  printf '%s\n' '  - name: in-cluster'
  printf '%s\n' '    context:'
  printf '%s\n' '      cluster: in-cluster'
  printf '%s\n' '      user: signalforge-agent'
  if [[ -n "$KUBE_CONTEXT_ALIAS" && "$KUBE_CONTEXT_ALIAS" != "in-cluster" ]]; then
    printf '%s\n' "  - name: ${KUBE_CONTEXT_ALIAS}"
    printf '%s\n' '    context:'
    printf '%s\n' '      cluster: in-cluster'
    printf '%s\n' '      user: signalforge-agent'
  fi
  printf '%s\n' "current-context: ${KUBE_CONTEXT_ALIAS:-in-cluster}"
  printf '%s\n' 'users:'
  printf '%s\n' '  - name: signalforge-agent'
  printf '%s\n' '    user:'
  printf '%s\n' '      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token'
} >"$rendered_kubeconfig"

sed \
  -e "0,/name: signalforge/{s/name: signalforge/name: ${NAMESPACE}/}" \
  -e "s/namespace: signalforge/namespace: ${NAMESPACE}/g" \
  "$MANIFEST_PATH" >"$rendered_manifest"

kubectl "${kubectl_args[@]}" apply -f "$rendered_manifest"

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" create configmap signalforge-agent-kubeconfig \
  --from-file=kubeconfig="$rendered_kubeconfig" \
  --dry-run=client -o yaml | kubectl "${kubectl_args[@]}" apply -f -

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" create secret generic signalforge-agent-token \
  --from-literal=token="$AGENT_TOKEN" \
  --dry-run=client -o yaml | kubectl "${kubectl_args[@]}" apply -f -

if [[ "$SKIP_PULL_SECRET" != "true" && -n "$ACR_NAME" ]]; then
  if ! command -v az >/dev/null 2>&1; then
    echo "Azure CLI is required when --acr-name is set." >&2
    exit 1
  fi

  registry_server="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv | tr -d '\r')"
  access_token="$(az acr login --name "$ACR_NAME" --expose-token --query accessToken -o tsv | tr -d '\r')"

  kubectl "${kubectl_args[@]}" -n "$NAMESPACE" create secret docker-registry "$PULL_SECRET_NAME" \
    --docker-server="$registry_server" \
    --docker-username='00000000-0000-0000-0000-000000000000' \
    --docker-password="$access_token" \
    --dry-run=client -o yaml | kubectl "${kubectl_args[@]}" apply -f -

  kubectl "${kubectl_args[@]}" -n "$NAMESPACE" patch serviceaccount signalforge-agent \
    --type merge \
    --patch "{\"imagePullSecrets\":[{\"name\":\"$PULL_SECRET_NAME\"}]}"
fi

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" set image "deployment/${DEPLOYMENT_NAME}" \
  "signalforge-agent=${IMAGE}"

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" set env "deployment/${DEPLOYMENT_NAME}" \
  "SIGNALFORGE_URL=${SIGNALFORGE_URL}"

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" rollout restart "deployment/${DEPLOYMENT_NAME}"

kubectl "${kubectl_args[@]}" -n "$NAMESPACE" rollout status "deployment/${DEPLOYMENT_NAME}" --timeout=180s

echo
echo "Deployment is ready."
echo "Namespace: $NAMESPACE"
echo "Deployment: $DEPLOYMENT_NAME"
echo "Image: $IMAGE"
echo "SignalForge URL: $SIGNALFORGE_URL"
echo
echo "Useful checks:"
echo "  kubectl ${KUBE_CONTEXT:+--context $KUBE_CONTEXT }-n $NAMESPACE get pods"
echo "  kubectl ${KUBE_CONTEXT:+--context $KUBE_CONTEXT }-n $NAMESPACE logs deploy/$DEPLOYMENT_NAME --tail=50"
