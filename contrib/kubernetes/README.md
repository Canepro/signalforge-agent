# Kubernetes Agent Deployment

Use this path when you want `kubernetes-bundle` collection to run as an always-on
cluster-side agent instead of depending on a workstation session.

This repo treats the Kubernetes runner as:

- a dedicated deployment in namespace `signalforge`
- a dedicated service account with read-only cluster access
- a cluster-capable runner by default
- `curl` as the default artifact upload transport for this deployment form
- a consumer of cluster or namespace-scoped jobs from SignalForge, depending on the queued `collection_scope`

## Why this path exists

Cluster-side deployment is the preferred durable form for `kubernetes-bundle` collection.
This repo keeps that path portable by separating three concerns:

1. build or publish an image in whatever registry your cluster can pull from
2. deploy with the checked-in manifest plus the rollout script
3. validate against a real queued job

That keeps registry choice, cluster auth, and deployment wiring explicit instead of tied to one operator environment.
The reference manifest also pins `SIGNALFORGE_AGENT_UPLOAD_TRANSPORT=curl`, because that has
proven more reliable than Bun multipart upload in the hardened cluster-side container runtime.

## Registry stance

The preferred portable image path is a public image such as:

- `ghcr.io/<owner>/signalforge-agent:<tag>`

For private registries, the deploy script supports two paths:

- Azure helper: `--acr-name <name>`
- generic docker-registry credentials: `--registry-server`, `--registry-username`, and `--registry-password-file`

## Prerequisites

- `kubectl` pointed at the target cluster
- an enrolled SignalForge agent token for the Kubernetes source you want this runner to serve
- sibling repo layout:
  - `../signalforge-agent`
  - `../signalforge-collectors`

If you want to use the optional Azure ACR build helper, also install `az` and log into the subscription that owns that registry.

## 1. Publish or choose a cluster image

### Portable default: use a public image

Build and publish an image with your normal registry workflow, then deploy it by full reference:

```bash
IMAGE=ghcr.io/example/signalforge-agent:kubernetes-arm64-20260401
```

### Optional Azure helper: remote-build into ACR

If your cluster pulls from Azure Container Registry and you want a checked-in remote build path:

```bash
cd /path/to/signalforge-agent

./scripts/publish-kubernetes-image.sh   --registry exampleacr   --image signalforge-agent:kubernetes-arm64-$(date +%Y%m%d-%H%M%S)
```

By default this publishes `linux/arm64`. Override with `--platform` only when the cluster
is not arm64.

## 2. Deploy the cluster-side runner

### Public image or already-accessible private image

```bash
cd /path/to/signalforge-agent

./scripts/deploy-kubernetes-agent.sh   --image ghcr.io/example/signalforge-agent:kubernetes-arm64-20260401   --signalforge-base-url https://signalforge.example.com   --agent-token-file /secure/path/signalforge-kubernetes-agent.token   --kube-context-alias prod-cluster
```

### Private registry with generic credentials

```bash
./scripts/deploy-kubernetes-agent.sh   --image registry.example.com/platform/signalforge-agent:kubernetes-arm64-20260401   --signalforge-base-url https://signalforge.example.com   --agent-token-file /secure/path/signalforge-kubernetes-agent.token   --kube-context-alias prod-cluster   --registry-server registry.example.com   --registry-username signalforge-agent   --registry-password-file /secure/path/registry.password
```

### Private registry via Azure helper

```bash
./scripts/deploy-kubernetes-agent.sh   --image exampleacr.azurecr.io/signalforge-agent:kubernetes-arm64-20260401   --signalforge-base-url https://signalforge.example.com   --agent-token-file /secure/path/signalforge-kubernetes-agent.token   --kube-context-alias prod-cluster   --acr-name exampleacr
```

What the deploy script does:

- applies `contrib/kubernetes/deployment.yaml`
- creates or updates the `signalforge-agent-token` secret
- creates or updates the in-cluster kubeconfig `ConfigMap`, with an optional context alias that matches queued job scope
- optionally creates or updates an image pull secret
- patches the `signalforge-agent` service account with that pull secret when one is managed
- sets the deployment image and `SIGNALFORGE_BASE_URL`
- keeps cluster-side artifact uploads on the explicit `curl` transport
- waits for rollout success

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
./scripts/deploy-kubernetes-agent.sh   --image <new-image>   --signalforge-base-url <signalforge-url>   --agent-token-file <token-file>
```

To remove an obsolete failed namespace from earlier experiments:

```bash
kubectl delete namespace signalforge-agent-system
```
