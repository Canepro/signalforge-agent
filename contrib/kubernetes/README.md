# Kubernetes Agent Deployment

Use this path when you want `kubernetes-bundle` collection to run as an always-on
cluster-side agent instead of depending on a workstation session.

The preferred install method is the Helm chart in `charts/signalforge-agent`.
The raw manifest and `deploy-kubernetes-agent.sh` helper remain available as a secondary path.

This repo treats the Kubernetes runner as:

- a dedicated deployment in namespace `signalforge`
- a dedicated service account with read-only cluster access
- a cluster-capable runner by default
- `curl` as the default artifact upload transport for this deployment form
- a consumer of cluster or namespace-scoped jobs from SignalForge, depending on the queued `collection_scope`

## Why this path exists

Cluster-side deployment is the preferred durable form for `kubernetes-bundle` collection.
This repo keeps that path portable by separating three concerns:

1. use the official image, or build and publish your own copy when you intentionally need a different registry
2. install the checked-in Helm chart with explicit values
3. validate against a real queued job

That keeps registry choice, cluster auth, and deployment wiring explicit instead of tied to one operator environment.
The reference manifest also pins `SIGNALFORGE_AGENT_UPLOAD_TRANSPORT=curl`, because that has
proven more reliable than Bun multipart upload in the hardened cluster-side container runtime.

## Registry stance

The preferred operator path is the official public image:

- `ghcr.io/canepro/signalforge-agent:latest`

For private registries, set `image.repository`, `image.tag`, and `image.pullSecrets` in Helm values.

## Prerequisites

- `kubectl` pointed at the target cluster
- an enrolled SignalForge agent token for the Kubernetes source you want this runner to serve

If you want to build your own registry copy instead of using the official image, you also need:

- sibling repo layout:
  - `../signalforge-agent`
  - `../signalforge-collectors`
- `az` logged into the target subscription for the optional ACR helper path

## 1. Use the official cluster image

The preferred image is the official public GHCR package:

```bash
IMAGE=ghcr.io/canepro/signalforge-agent:latest
```

If you need a pinned immutable tag, use a published Git tag or SHA tag from the same package:

```bash
IMAGE=ghcr.io/canepro/signalforge-agent:sha-<commit>
```

### Optional Azure helper: remote-build into ACR

This remains available when you intentionally need your own registry copy, but it is not the preferred operator path.

If your cluster pulls from Azure Container Registry and you want a checked-in remote build path:

```bash
cd /path/to/signalforge-agent

./scripts/publish-kubernetes-image.sh   --registry exampleacr   --image signalforge-agent:kubernetes-arm64-$(date +%Y%m%d-%H%M%S)
```

By default this publishes `linux/arm64`. Override with `--platform` only when the cluster
is not arm64.

## 2. Deploy the cluster-side runner with Helm

### Official image with an inline token value

```bash
cd /path/to/signalforge-agent

helm upgrade --install signalforge-agent ./charts/signalforge-agent \
  --namespace signalforge \
  --create-namespace \
  --set signalforge.baseUrl=https://signalforge.example.com \
  --set-file agent.token.value=/secure/path/signalforge-kubernetes-agent.token \
  --set agent.kubeContextAlias=prod-cluster
```

### Official image with an existing Secret

```bash
helm upgrade --install signalforge-agent ./charts/signalforge-agent \
  --namespace signalforge \
  --create-namespace \
  --set signalforge.baseUrl=https://signalforge.example.com \
  --set agent.token.existingSecret=signalforge-agent-token \
  --set agent.kubeContextAlias=prod-cluster
```

### Private registry image

```bash
helm upgrade --install signalforge-agent ./charts/signalforge-agent \
  --namespace signalforge \
  --create-namespace \
  --set signalforge.baseUrl=https://signalforge.example.com \
  --set-file agent.token.value=/secure/path/signalforge-kubernetes-agent.token \
  --set agent.kubeContextAlias=prod-cluster \
  --set image.repository=registry.example.com/platform/signalforge-agent \
  --set image.tag=kubernetes-arm64-20260401 \
  --set image.pullSecrets[0]=signalforge-agent-regcred
```

What the chart installs:

- a token `Secret` unless you point the chart at an existing Secret
- the in-cluster kubeconfig `ConfigMap`, with an optional context alias that matches queued job scope
- the service account, read-only cluster RBAC, and deployment
- the official image by default
- cluster-side artifact uploads on the explicit `curl` transport

## 3. Validate the deployment

Basic runtime checks:

```bash
kubectl -n signalforge get pods
kubectl -n signalforge logs deploy/signalforge-agent --tail=50
kubectl -n signalforge rollout status deploy/signalforge-agent
```

Expected log shape:

- poll loop started
- no queued job, or
- claimed job
- started job
- upload complete

## 4. Validate with a real SignalForge job

Queue a real `kubernetes-bundle` job for the source that this token belongs to, then watch:

```bash
kubectl -n signalforge logs deploy/signalforge-agent -f
```

Success looks like:

- `claimed job ...`
- `collector produced for kubernetes-bundle: ...`
- `upload complete: run_id=...`
- `job ... finished (run_status=complete, result_analysis_status=complete)`

If SignalForge queues `collection_scope.kubectl_context`, pass the same value as
`--kube-context-alias` during deployment so the in-cluster runner exposes that context name.

## Cleanup and re-roll

To redeploy a new image:

```bash
helm upgrade signalforge-agent ./charts/signalforge-agent \
  --namespace signalforge \
  --reuse-values \
  --set image.tag=<new-tag>
```

To remove an obsolete failed namespace from earlier experiments:

```bash
kubectl delete namespace signalforge-agent-system
```

## Secondary raw-manifest path

If you deliberately want a non-Helm path, the checked-in helper still works:

```bash
./scripts/deploy-kubernetes-agent.sh \
  --image ghcr.io/canepro/signalforge-agent:latest \
  --signalforge-base-url https://signalforge.example.com \
  --agent-token-file /secure/path/signalforge-kubernetes-agent.token \
  --kube-context-alias prod-cluster
```
