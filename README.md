# signalforge-agent

Thin **execution-plane** runtime for [SignalForge](https://github.com/Canepro/signalforge): it authenticates with a **source-bound** agent token, heartbeats, polls for **collection jobs**, claims and starts them, dispatches family-specific collectors from **[signalforge-collectors](https://github.com/Canepro/signalforge-collectors)**, uploads the artifact, and reports failures.

## Boundaries

| Repo | Role |
|------|------|
| **signalforge** | Control plane: sources, jobs, registrations, analysis, UI. |
| **signalforge-collectors** | Collector **implementations** only (e.g. `first-audit.sh`). No job API client here. |
| **signalforge-agent** (this repo) | Orchestration: HTTP to SignalForge + local invocation of family-specific collectors. |

SignalForge never runs collectors on your hosts; this agent never reimplements collector logic.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Linux or WSL for the host-agent slice
- A checkout of **signalforge-collectors** on the same machine (unless using file override mode)

## Install

```bash
cd signalforge-agent
bun install
```

Run via `bun` (development):

```bash
bun run src/cli.ts help
```

Or link the CLI (optional):

```bash
bun link
signalforge-agent help
```

## Configuration

All configuration is **environment variables** (see `.env.example`).

| Variable | Required | Description |
|----------|----------|-------------|
| `SIGNALFORGE_BASE_URL` or `SIGNALFORGE_URL` | yes | Origin only, no trailing slash (e.g. `http://localhost:3000`) |
| `SIGNALFORGE_AGENT_TOKEN` | yes* | Bearer token from `POST /api/agent/registrations` (one source per token) |
| `SIGNALFORGE_AGENT_TOKEN_FILE` | yes* | File containing the bearer token. Preferred for long-running services. |
| `SIGNALFORGE_AGENT_INSTANCE_ID` | yes | Opaque stable id for **this process**; must match claim/start/fail/artifact and lease-extension heartbeats |
| `SIGNALFORGE_COLLECTORS_DIR` | yes* | Absolute path to **signalforge-collectors** root (family-specific collector scripts live there) |
| `SIGNALFORGE_AGENT_WORKDIR` | no | Writable directory for collector output files. Defaults to `SIGNALFORGE_COLLECTORS_DIR`; containerized runners should usually set this to a writable volume such as `/work` |
| `SIGNALFORGE_AGENT_UPLOAD_TRANSPORT` | no | Artifact upload transport. `fetch` by default. Use `curl` for hardened Kubernetes runners if Bun multipart upload is unreliable in that runtime |
| `SIGNALFORGE_AGENT_CAPABILITIES` | no | Comma-separated heartbeat capabilities. When omitted, the agent derives capabilities from local readiness and always includes `upload:multipart`. Container capability now requires real Docker or Podman access, not only a binary on `PATH` |
| `SIGNALFORGE_POLL_INTERVAL_MS` | no | Default `30000`; minimum `1000`; base sleep after gate paths and claim conflicts in `run` mode |
| `SIGNALFORGE_MAX_BACKOFF_MS` | no | Default `300000`; minimum `1000`; ceiling for exponential backoff on transient network or 5xx/429 API failures in `run` mode |
| `SIGNALFORGE_JOBS_WAIT_SECONDS` | no | Default `20`; max `20`; bounded long-poll window for `GET /api/agent/jobs/next` in `run` mode |
| `SIGNALFORGE_KUBECTL_BIN` | no | Override the `kubectl` binary name or path used for capability detection and preflight |
| `SIGNALFORGE_KUBECONFIG` | no | Explicit kubeconfig path for a hardened Kubernetes-capable runner; preferred over ambient user context |
| `SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS` | no | Default `45000`; minimum `1000` — interval for mid-job lease heartbeats while collecting |
| `SIGNALFORGE_AGENT_ARTIFACT_FILE` | no | If set, **skip** collector dispatch and upload this file (tests / air-gapped) |
| `SIGNALFORGE_AGENT_VERSION` | no | Sent as `agent_version` on heartbeat (default: package version) |

\* Set **one** of `SIGNALFORGE_AGENT_TOKEN` or `SIGNALFORGE_AGENT_TOKEN_FILE`. `SIGNALFORGE_AGENT_TOKEN_FILE` is the preferred service path. `SIGNALFORGE_COLLECTORS_DIR` is not required when `SIGNALFORGE_AGENT_ARTIFACT_FILE` is set.

Example:

```bash
export SIGNALFORGE_BASE_URL=http://localhost:3000
export SIGNALFORGE_AGENT_TOKEN='…'
export SIGNALFORGE_AGENT_INSTANCE_ID="$(hostname)-agent-1"
export SIGNALFORGE_COLLECTORS_DIR="$HOME/src/signalforge-collectors"
# Optional override. If omitted, the agent advertises only the families it can run locally.
export SIGNALFORGE_AGENT_CAPABILITIES='collect:linux-audit-log,upload:multipart'
```

## Commands

| Command | Behavior |
|---------|----------|
| `signalforge-agent once` | Idle heartbeat → poll **one** `GET /api/agent/jobs/next` → if a job exists, claim → start → collect → `POST …/artifact` → exit |
| `signalforge-agent run` | Idle heartbeat → long-poll `GET /api/agent/jobs/next` → process work immediately when available; sleeps by `SIGNALFORGE_POLL_INTERVAL_MS` on gate paths and claim conflicts, and uses exponential backoff up to `SIGNALFORGE_MAX_BACKOFF_MS` on transient network or retryable upstream API failures |
| `signalforge-agent preflight` | Validate config, token source, and locally runnable collector/runtime capabilities before enabling the service. This includes actual Docker or Podman reachability for container-capable hosts |
| `signalforge-agent help` | Usage and env summary |
| `signalforge-agent version` | Print version |

### Exit codes (`once`)

| Code | Meaning |
|------|---------|
| 0 | Success: no queued job, or job completed (including idempotent `409 job_already_submitted` on artifact) |
| 1 | Usage / unknown subcommand |
| 2 | Authentication failed (`401`) |
| 3 | Collector failed (`first-audit.sh` non-zero, aborted, or no **new/updated** audit log detected) |
| 4 | Lease rejected (`active_job_lease.extended === false`), other API / upload / unexpected error |
| 5 | Claim conflict (`409` on claim — another instance holds the lease) |
| 6 | Configuration error |

In **`run`** mode, **claim conflict (5)** is logged and the loop continues after the poll interval. Transient network and retryable upstream API failures (`408`, `425`, `429`, `5xx`) back off exponentially from `SIGNALFORGE_POLL_INTERVAL_MS` up to `SIGNALFORGE_MAX_BACKOFF_MS`. Other fatal errors stop the process with the same codes as above. **`401`** always stops the loop.

## End-to-end lifecycle

1. **Operator** creates a **Source** and enrolls an agent: `POST /api/agent/registrations` → save `token`.
2. **Operator** clicks “Collect Fresh Evidence” (or `POST …/collection-jobs`) → job is **queued**.
3. **Agent** `POST /api/agent/heartbeat` with a configured capability set. When not explicitly overridden, it derives that set from locally runnable collectors and always includes `upload:multipart` (required for strict gating on `jobs/next`).
4. **Agent** `GET /api/agent/jobs/next?limit=1` (and in `run` mode, `wait_seconds` for bounded long-poll).
5. **Agent** `POST /api/collection-jobs/{id}/claim` with `instance_id` + lease TTL.
6. **Agent** `POST /api/collection-jobs/{id}/start` with `instance_id`.
7. **Immediately** and on **`SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS`**, **agent** sends mid-job heartbeats with `active_job_id` + `instance_id`. If the response includes `active_job_lease.extended === false`, the agent **stops**: it aborts the running collector script, **does not upload**, and `POST …/fail` with code **`lease_not_extended`** so the job is not left ambiguously “running” on the client side.
8. **Agent** dispatches by `job.artifact_type`: `linux-audit-log` runs **`bash first-audit.sh`**, `container-diagnostics` runs **`bash collect-container-diagnostics.sh`**, and `kubernetes-bundle` runs **`bash collect-kubernetes-bundle.sh`** from `SIGNALFORGE_COLLECTORS_DIR`. When `jobs/next` includes typed `collection_scope`, the agent maps that scope to explicit collector flags. When scope is absent, it falls back to the collector's existing env/default behavior. The agent still requires a family-specific artifact that is new or has a newer mtime than before the run. Or it uses `SIGNALFORGE_AGENT_ARTIFACT_FILE`.
9. **Another** mid-job heartbeat runs **immediately before** `POST …/artifact` to catch lease loss after a long collection.
10. **Agent** `POST /api/collection-jobs/{id}/artifact` with multipart `file` + form fields `instance_id` and `artifact_type`.
11. On collector or upload failure, **agent** `POST …/fail` with `instance_id`, `code` (`collector_failed`, `agent_failed`, or `lease_not_extended`), and `message`. stderr includes server error bodies when available.

During execution, the claim log now includes the queued job id, artifact type (`artifact_type`), and resolved scope summary so non-Linux support and operator intent are visible in support logs without reconstructing the job from the API.

Contract details: SignalForge [`plans/phase-6b-source-job-api-contract.md`](https://github.com/Canepro/signalforge/blob/main/plans/phase-6b-source-job-api-contract.md), [`docs/api-contract.md`](https://github.com/Canepro/signalforge/blob/main/docs/api-contract.md).

## Collector invocation

- **No** audit logic lives in this repo.
- The agent dispatches a fixed script per supported artifact family from **signalforge-collectors** and only accepts a fresh artifact from that family. It snapshots matching output files before the script and refuses stale files.
- To change *how* evidence is gathered, edit **signalforge-collectors**, not this agent.
- Preferred Phase 9 path:
  - `container_target` scope maps to `collect-container-diagnostics.sh --container ... [--runtime ...] [--hostname ...]`
  - `kubernetes_scope` maps to `collect-kubernetes-bundle.sh --scope ... [--namespace ...] [--context ...] [--cluster-name ...] [--provider ...]`
  - `linux_host` needs no extra collector arguments
- Legacy fallback remains available when `collection_scope` is missing, but it should not be the normal operator story.

## Limitations (v0.1)

- One **source** per token; one **active job** at a time per process.
- **Linux / WSL** host-agent slice by default, but the execution path now advertises and dispatches `linux-audit-log`, `container-diagnostics`, and `kubernetes-bundle` capabilities.
- Container and Kubernetes jobs still depend on local runtime access. Phase 9 removes the need to pre-bake per-job target state into host env, but the host still must have the relevant runtime tools and permissions.
- No realtime push/broker; bounded long-poll only.
- No token rotation, notifications, or multi-source agents.

## Run As A Service

For normal operator use, prefer a long-running service over repeated manual `once` calls.

The repo includes:

- `contrib/systemd/signalforge-agent.service` — template rendered by the installer
- `contrib/systemd/signalforge-agent.env.example` — copy to a local env file and fill once
- `scripts/install-systemd-service.sh` — installs either a system or user `systemd` unit, copies the env and token files, and enables the service
- `contrib/container/Dockerfile` — reference image that bakes the agent plus `signalforge-collectors`
- `contrib/container/docker-compose.yml` — reference container-host deployment for `container-diagnostics`
- `contrib/kubernetes/deployment.yaml` — reference cluster-side deployment for `kubernetes-bundle`
- `charts/signalforge-agent` — preferred Helm chart for cluster-side deployment
- `scripts/build-container-image.sh` — builds the reference image from sibling `signalforge-agent` and `signalforge-collectors` checkouts
- `contrib/kubernetes/README.md` — repeatable cluster-side rollout and validation guide
- `scripts/publish-kubernetes-image.sh` — publishes a Kubernetes-target image remotely with `az acr build`
- `scripts/deploy-kubernetes-agent.sh` — secondary raw-manifest deployment helper

Recommended flow for a system service:

```bash
cp contrib/systemd/signalforge-agent.env.example contrib/systemd/signalforge-agent.env
cp contrib/systemd/signalforge-agent.token.example contrib/systemd/signalforge-agent.token
# Optional for a Kubernetes-capable runner:
# cp /secure/path/kubeconfig contrib/systemd/signalforge-agent.kubeconfig
$EDITOR contrib/systemd/signalforge-agent.env
$EDITOR contrib/systemd/signalforge-agent.token
sudo ./scripts/install-systemd-service.sh --scope system
```

Recommended flow for a user service when you want operator-owned persistence without root-managed unit files:

```bash
cp contrib/systemd/signalforge-agent.env.example contrib/systemd/signalforge-agent.env
cp contrib/systemd/signalforge-agent.token.example contrib/systemd/signalforge-agent.token
$EDITOR contrib/systemd/signalforge-agent.env
$EDITOR contrib/systemd/signalforge-agent.token
./scripts/install-systemd-service.sh --scope user
```

For runtime-host collection where the agent needs direct Docker or Podman access from the host,
use the less restrictive runtime-host profile instead of the default hardened host-audit profile:

```bash
sudo ./scripts/install-systemd-service.sh --scope system --service-name signalforge-agent-container --service-profile runtime-host
./scripts/install-systemd-service.sh --scope user --service-name signalforge-agent-container --service-profile runtime-host
```

The installer:

- copies your env file to a managed location for the chosen scope
- copies the token to a separate managed token file
- optionally copies `contrib/systemd/signalforge-agent.kubeconfig` to a managed kubeconfig path
- strips any inline token from the installed env file
- writes `SIGNALFORGE_KUBECONFIG=<managed-path>` into the installed env file when that managed kubeconfig is present
- renders the service with the current checkout path and absolute Bun binary
- uses `LoadCredential=` for system units and a direct token-file env path for user units
- can render either:
  - the default hardened `standard` profile for host-style collection
  - the reduced `runtime-host` profile for container-runtime access on the host
- runs a `preflight --quiet` gate before `ExecStart`
- enables the unit through either `systemctl` or `systemctl --user`

After install:

```bash
systemctl status signalforge-agent
systemctl --user status signalforge-agent
journalctl -u signalforge-agent -f
journalctl --user -u signalforge-agent -f
```

To inspect the rendered unit and installed credential layout without touching `systemd`:

```bash
./scripts/install-systemd-service.sh --scope system --dry-run
./scripts/install-systemd-service.sh --scope user --dry-run
```

If you use `--scope user` and want the service to survive reboot without an active login session, enable linger once:

```bash
sudo loginctl enable-linger $(id -un)
```

### Preferred deployment matrix

The preferred long-running form depends on the artifact family and execution surface.

| Artifact family | Preferred deployment form | Why |
|----------------|---------------------------|-----|
| `linux-audit-log` | host service (`systemd --system` or `systemd --user`) | The collector audits the host itself. Running it inside another container would audit the wrong surface. |
| `container-diagnostics` | runtime-host service or containerized runner on the runtime host | Keep the agent near the real runtime socket. Prefer a system unit when you can install one cleanly; use a user unit or containerized runner when that matches the host's trust and privilege model better. |
| `kubernetes-bundle` | cluster-side Kubernetes Deployment | Best fit for always-on polling with explicit kubeconfig or in-cluster identity and without depending on a workstation session. |

Across all forms:

- keep the token in a root-controlled file or mounted secret, not in shell history or process args
- pin capabilities to the family that actually makes sense for that deployment form
- run `signalforge-agent preflight` before enabling or promoting the workload

For the reference Kubernetes deployment, the manifest pins `SIGNALFORGE_AGENT_UPLOAD_TRANSPORT=curl`.
That is the preferred cluster-side default because it has been more reliable than Bun multipart upload
inside the hardened arm64 Kubernetes container runtime used during validation.

### Runtime-host `systemd` packaging for `container-diagnostics`

When you can install a long-running host service, this is a strong default for Podman or Docker-backed hosts because:

- the agent still runs as the target host user, so it sees the correct rootless runtime state
- a system unit can start at boot without depending on a login session
- a user unit is also supported when that better matches the host's trust and privilege model
- you avoid wrapping a host-adjacent collector in another container just to supervise it

Use the same installer flow as host audit, but switch the service profile:

```bash
cp contrib/systemd/signalforge-agent.env.example contrib/systemd/signalforge-agent-container.env
cp contrib/systemd/signalforge-agent.token.example contrib/systemd/signalforge-agent-container.token
$EDITOR contrib/systemd/signalforge-agent-container.env
$EDITOR contrib/systemd/signalforge-agent-container.token
sudo ./scripts/install-systemd-service.sh   --scope system   --service-name signalforge-agent-container   --service-profile runtime-host   --env-source contrib/systemd/signalforge-agent-container.env   --token-source contrib/systemd/signalforge-agent-container.token
```

Or the same shape as a user-owned service when that is the cleaner operational fit for the host:

```bash
./scripts/install-systemd-service.sh   --scope user   --service-name signalforge-agent-container   --service-profile runtime-host   --env-source contrib/systemd/signalforge-agent-container.env   --token-source contrib/systemd/signalforge-agent-container.token
```

Recommended env choices for this form:

- pin `SIGNALFORGE_AGENT_CAPABILITIES=collect:container-diagnostics,upload:multipart`
- set `SIGNALFORGE_CONTAINER_RUNTIME=podman` or `docker` when you want the collector-side default to stay explicit
- keep the token in the separate token file, not inline in the env file

### Containerized runner packaging for `container-diagnostics`

Build the image from sibling repo checkouts:

```bash
./scripts/build-container-image.sh signalforge-agent:local
```

To target a non-default CPU architecture such as an `arm64` Kubernetes cluster from an `amd64` workstation:

```bash
SIGNALFORGE_IMAGE_PLATFORM=linux/arm64 ./scripts/build-container-image.sh signalforge-agent:arm64
```

This expects the default workspace layout:

- `../signalforge-agent`
- `../signalforge-collectors`

Or set `SIGNALFORGE_COLLECTORS_REPO=/absolute/path/to/signalforge-collectors`.

Important constraints:

- the image contains all collectors, so containerized deployments should pin `SIGNALFORGE_AGENT_CAPABILITIES` to the family that actually makes sense there
- the bundled Docker Compose file is for a container-host runner and pins `collect:container-diagnostics,upload:multipart`
- the bundled Kubernetes deployment pins `collect:kubernetes-bundle,upload:multipart`
- do not run the image with auto-derived capabilities and assume Linux host collection is valid from inside the container

Container-host runner with Docker:

```bash
cp contrib/container/signalforge-agent.container.env.example contrib/container/signalforge-agent.container.env
cp contrib/container/signalforge-agent.container.token.example contrib/container/signalforge-agent.container.token
$EDITOR contrib/container/signalforge-agent.container.env
$EDITOR contrib/container/signalforge-agent.container.token
docker-compose -f contrib/container/docker-compose.yml up -d
```

This form mounts `/var/run/docker.sock` and should be treated as a higher-trust host profile.
The reference Compose file runs the container with a read-only root filesystem plus a writable tmpfs at `/work`, which is where collectors emit temporary artifacts before upload.

Treat this as the preferred long-running packaging form when:

- you are collecting `container-diagnostics`
- the runtime host already operates Docker or Podman comfortably
- mounting the runtime socket into the runner is an acceptable trust tradeoff

Still validate:

- `signalforge-agent preflight` as the final runtime user or container user
- actual daemon or socket reachability, not just the runtime binary

### Preferred cluster-side packaging for `kubernetes-bundle`

Use the Helm chart when a cluster-side runner is the right operational model.
For a repeatable rollout, prefer the official public image plus the checked-in chart:

```bash
helm upgrade --install signalforge-agent ./charts/signalforge-agent \
  --namespace signalforge \
  --create-namespace \
  --set signalforge.baseUrl=https://signalforge.example.com \
  --set-file agent.token.value=/secure/path/signalforge-kubernetes-agent.token \
  --set agent.kubeContextAlias=prod-cluster
```

If your registry is private, set the image registry values instead:

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

If you already manage the token as a Secret, reference it instead of passing the token at install time:

```bash
helm upgrade --install signalforge-agent ./charts/signalforge-agent \
  --namespace signalforge \
  --create-namespace \
  --set signalforge.baseUrl=https://signalforge.example.com \
  --set agent.token.existingSecret=signalforge-agent-token \
  --set agent.kubeContextAlias=prod-cluster
```

What the chart gives you by default:

- a dedicated `signalforge` namespace for the runner itself
- a dedicated `signalforge-agent` service account
- a cluster-capable read-only `ClusterRole` and `ClusterRoleBinding`
- an in-cluster kubeconfig `ConfigMap` that uses the pod's own service-account token instead of a copied external kubeconfig file
- a writable `emptyDir` at `/work`, and `TMPDIR=/work`, because collectors emit artifacts before upload and use temporary files

Before using it:

- use the official `ghcr.io/canepro/signalforge-agent:latest` image, or override it with your own registry copy through chart values
- add an image pull secret if the registry is private
- keep the capability override pinned to `collect:kubernetes-bundle,upload:multipart`

Operational stance:

- the runner should live in its own dedicated namespace, not inside the monitored workload namespace
- the runner should be cluster-capable by default so the Kubernetes bundle stays credible for platform diagnostics
- namespace-scoped collection is still supported, but it should come from the queued `collection_scope`, not from weakening the default deployment shape

The raw-manifest helper remains available when you deliberately want a non-Helm path:

```bash
./scripts/deploy-kubernetes-agent.sh \
  --image ghcr.io/canepro/signalforge-agent:latest \
  --signalforge-base-url https://signalforge.example.com \
  --agent-token-file /secure/path/signalforge-kubernetes-agent.token \
  --kube-context-alias prod-cluster
```

See `contrib/kubernetes/README.md` for the full Helm-first publish, deploy, validate, and cleanup flow.

Treat this as the preferred long-running packaging form when:

- you are collecting `kubernetes-bundle`
- a cluster-side Deployment is easier to operate than a bastion or host service
- in-cluster identity is acceptable for that cluster

### Preferred host `systemd` packaging for `linux-audit-log`

Use the `systemd` install flow as the preferred path for Linux and WSL host audit collection:

- `contrib/systemd/signalforge-agent.service`
- `contrib/systemd/signalforge-agent.env.example`
- `scripts/install-systemd-service.sh`

This remains the preferred path for `linux-audit-log` because the audit should run on the host itself, not inside a wrapper container that would inspect the wrong filesystem, process table, and network namespace.

If you want fixed-time scheduled collection instead, use cron or a systemd timer with `signalforge-agent once`, but that is less responsive for operator-triggered “collect now” requests because queued jobs wait until the next invocation.

## Development

```bash
bun test
bun run typecheck
```

## License

MIT
