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
| `SIGNALFORGE_URL` or `SIGNALFORGE_BASE_URL` | yes | Origin only, no trailing slash (e.g. `http://localhost:3000`) |
| `SIGNALFORGE_AGENT_TOKEN` | yes* | Bearer token from `POST /api/agent/registrations` (one source per token) |
| `SIGNALFORGE_AGENT_TOKEN_FILE` | yes* | File containing the bearer token. Preferred for long-running services. |
| `SIGNALFORGE_AGENT_INSTANCE_ID` | yes | Opaque stable id for **this process**; must match claim/start/fail/artifact and lease-extension heartbeats |
| `SIGNALFORGE_COLLECTORS_DIR` | yes* | Absolute path to **signalforge-collectors** root (family-specific collector scripts live there) |
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
export SIGNALFORGE_URL=http://localhost:3000
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
- `scripts/install-systemd-service.sh` — installs the env file and service, reloads `systemd`, and enables the unit
- `contrib/container/Dockerfile` — reference image that bakes the agent plus `signalforge-collectors`
- `contrib/container/docker-compose.yml` — reference container-host deployment for `container-diagnostics`
- `contrib/kubernetes/deployment.yaml` — reference cluster-side deployment for `kubernetes-bundle`
- `scripts/build-container-image.sh` — builds the reference image from sibling `signalforge-agent` and `signalforge-collectors` checkouts

Recommended flow:

```bash
cp contrib/systemd/signalforge-agent.env.example contrib/systemd/signalforge-agent.env
cp contrib/systemd/signalforge-agent.token.example contrib/systemd/signalforge-agent.token
# Optional for a Kubernetes-capable runner:
# cp /secure/path/kubeconfig contrib/systemd/signalforge-agent.kubeconfig
$EDITOR contrib/systemd/signalforge-agent.env
$EDITOR contrib/systemd/signalforge-agent.token
sudo ./scripts/install-systemd-service.sh
```

The installer:

- copies your env file to `/etc/signalforge-agent.env`
- copies the token to `/etc/signalforge-agent/token`
- optionally copies `contrib/systemd/signalforge-agent.kubeconfig` to `/etc/signalforge-agent/kubeconfig`
- strips any inline token from the installed env file
- writes `SIGNALFORGE_KUBECONFIG=/etc/signalforge-agent/kubeconfig` into the installed env file when that managed kubeconfig is present
- renders the service with the current checkout path, user, absolute Bun binary, and a `LoadCredential=` token mount
- runs a `preflight --quiet` gate before `ExecStart`
- then runs:

- `systemctl daemon-reload`
- `systemctl enable --now signalforge-agent`

After install:

```bash
systemctl status signalforge-agent
journalctl -u signalforge-agent -f
```

To inspect the rendered unit and installed credential layout without touching `systemd`:

```bash
./scripts/install-systemd-service.sh --dry-run
```

### Preferred deployment matrix

The preferred long-running form depends on the artifact family and execution surface.

| Artifact family | Preferred deployment form | Why |
|----------------|---------------------------|-----|
| `linux-audit-log` | host `systemd` service | The collector audits the host itself. Running it inside another container would audit the wrong surface. |
| `container-diagnostics` | containerized runner on the runtime host | Easier long-running packaging for teams already operating Docker or Podman, while still staying near the runtime socket. |
| `kubernetes-bundle` | cluster-side Kubernetes Deployment | Best fit for always-on polling with explicit kubeconfig or in-cluster identity and without depending on a laptop or ambient shell context. |

Across all forms:

- keep the token in a root-controlled file or mounted secret, not in shell history or process args
- pin capabilities to the family that actually makes sense for that deployment form
- run `signalforge-agent preflight` before enabling or promoting the workload

### Preferred container-host packaging for `container-diagnostics`

Build the image from sibling repo checkouts:

```bash
./scripts/build-container-image.sh signalforge-agent:local
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

Use the bundled deployment manifest when a cluster-side runner is the right operational model:

```bash
kubectl apply -f contrib/kubernetes/deployment.yaml
```

Before using it:

- replace the placeholder token and kubeconfig secrets
- replace the placeholder image reference if you push the built image to a registry
- keep the capability override pinned to `collect:kubernetes-bundle,upload:multipart`
- keep the writable `emptyDir` mounted at `/work`, because collectors emit artifacts before upload

Treat this as the preferred long-running packaging form when:

- you are collecting `kubernetes-bundle`
- a cluster-side Deployment is easier to operate than a bastion or host service
- explicit kubeconfig or future in-cluster identity is acceptable for that cluster

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
