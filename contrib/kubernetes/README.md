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

Local cross-architecture builds are easy to get wrong on mixed `amd64` workstations and
`arm64` clusters. The repeatable default here is:

1. publish the image in Azure Container Registry with `az acr build`
2. deploy with the checked-in manifest plus the rollout script
3. validate against a real queued job

That keeps the build architecture, registry auth, and deployment wiring in one documented flow.
On WSL machines that use the Windows Azure CLI, the publish script automatically stages the
build on the Windows temp drive, passes an absolute Windows Dockerfile path to `az acr build`,
and forwards the target architecture so the bundled `kubectl` binary matches the cluster nodes.
The reference manifest also pins `SIGNALFORGE_AGENT_UPLOAD_TRANSPORT=curl`, because that has
proven more reliable than Bun multipart upload in the hardened cluster-side container runtime.

## Prerequisites

- `az` logged into the Azure subscription that can access your ACR
- `kubectl` pointed at the target cluster
- an enrolled SignalForge agent token for the Kubernetes source you want this runner to serve
- sibling repo layout:
  - `../signalforge-agent`
  - `../signalforge-collectors`

## 1. Publish an arm64 image in ACR

Build the image remotely so the cluster gets the correct architecture without relying on
local emulation:

```bash
cd /home/vincent/src/signalforge-agent

./scripts/publish-kubernetes-image.sh \
  --registry caneprophacr01 \
  --image signalforge-agent:oke-arm64-$(date +%Y%m%d-%H%M%S)
```

By default this publishes `linux/arm64`. Override with `--platform` only when the cluster
is not arm64.

## 2. Deploy the cluster-side runner

Use the published image, SignalForge URL, and the source-bound agent token:

```bash
cd /home/vincent/src/signalforge-agent

./scripts/deploy-kubernetes-agent.sh \
  --image caneprophacr01.azurecr.io/signalforge-agent:oke-arm64-20260330-180000 \
  --signalforge-url https://ca-signalforge-staging.kinddune-53ac219d.eastus2.azurecontainerapps.io \
  --agent-token-file /secure/path/signalforge-kubernetes-agent.token \
  --kube-context-alias oke-cluster \
  --acr-name caneprophacr01
```

What the deploy script does:

- applies `contrib/kubernetes/deployment.yaml`
- creates or updates the `signalforge-agent-token` secret
- creates or updates the in-cluster kubeconfig `ConfigMap`, with an optional context alias that matches queued job scope
- creates or updates an ACR pull secret when `--acr-name` is supplied
- patches the `signalforge-agent` service account with that pull secret
- sets the deployment image and `SIGNALFORGE_URL`
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
./scripts/deploy-kubernetes-agent.sh \
  --image <new-image> \
  --signalforge-url <signalforge-url> \
  --agent-token-file <token-file> \
  --acr-name <acr-name>
```

To remove an obsolete failed namespace from earlier experiments:

```bash
kubectl delete namespace signalforge-agent-system
```
