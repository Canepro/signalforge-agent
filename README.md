# signalforge-agent

Thin **execution-plane** runtime for [SignalForge](https://github.com/Canepro/signalforge): it authenticates with a **source-bound** agent token, heartbeats, polls for **collection jobs**, claims and starts them, runs collectors from **[signalforge-collectors](https://github.com/Canepro/signalforge-collectors)**, uploads the artifact, and reports failures.

## Boundaries

| Repo | Role |
|------|------|
| **signalforge** | Control plane: sources, jobs, registrations, analysis, UI. |
| **signalforge-collectors** | Collector **implementations** only (e.g. `first-audit.sh`). No job API client here. |
| **signalforge-agent** (this repo) | Orchestration: HTTP to SignalForge + **fixed** local invocation of collectors. |

SignalForge never runs collectors on your hosts; this agent never reimplements collector logic.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Linux or WSL (first slice)
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
| `SIGNALFORGE_AGENT_TOKEN` | yes | Bearer token from `POST /api/agent/registrations` (one source per token) |
| `SIGNALFORGE_AGENT_INSTANCE_ID` | yes | Opaque stable id for **this process**; must match claim/start/fail/artifact and lease-extension heartbeats |
| `SIGNALFORGE_COLLECTORS_DIR` | yes* | Absolute path to **signalforge-collectors** root (`first-audit.sh` lives there) |
| `SIGNALFORGE_POLL_INTERVAL_MS` | no | Default `30000`; minimum `1000`; backoff after gate/error in `run` mode |
| `SIGNALFORGE_JOBS_WAIT_SECONDS` | no | Default `20`; max `20`; bounded long-poll window for `GET /api/agent/jobs/next` in `run` mode |
| `SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS` | no | Default `45000`; minimum `1000` — interval for mid-job lease heartbeats while collecting |
| `SIGNALFORGE_AGENT_ARTIFACT_FILE` | no | If set, **skip** `first-audit.sh` and upload this file (tests / air-gapped) |
| `SIGNALFORGE_AGENT_VERSION` | no | Sent as `agent_version` on heartbeat (default: package version) |

\* Not required when `SIGNALFORGE_AGENT_ARTIFACT_FILE` is set.

Example:

```bash
export SIGNALFORGE_URL=http://localhost:3000
export SIGNALFORGE_AGENT_TOKEN='…'
export SIGNALFORGE_AGENT_INSTANCE_ID="$(hostname)-agent-1"
export SIGNALFORGE_COLLECTORS_DIR="$HOME/src/signalforge-collectors"
```

## Commands

| Command | Behavior |
|---------|----------|
| `signalforge-agent once` | Idle heartbeat → poll **one** `GET /api/agent/jobs/next` → if a job exists, claim → start → collect → `POST …/artifact` → exit |
| `signalforge-agent run` | Idle heartbeat → long-poll `GET /api/agent/jobs/next` → process work immediately when available; backs off by `SIGNALFORGE_POLL_INTERVAL_MS` on gate/error paths |
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

In **`run`** mode, **claim conflict (5)** is logged and the loop continues after the poll interval. Other fatal errors stop the process with the same codes as above. **`401`** always stops the loop.

## End-to-end lifecycle

1. **Operator** creates a **Source** and enrolls an agent: `POST /api/agent/registrations` → save `token`.
2. **Operator** clicks “Collect Fresh Evidence” (or `POST …/collection-jobs`) → job is **queued**.
3. **Agent** `POST /api/agent/heartbeat` with capabilities `collect:linux-audit-log` and `upload:multipart` (required for strict gating on `jobs/next`).
4. **Agent** `GET /api/agent/jobs/next?limit=1` (and in `run` mode, `wait_seconds` for bounded long-poll).
5. **Agent** `POST /api/collection-jobs/{id}/claim` with `instance_id` + lease TTL.
6. **Agent** `POST /api/collection-jobs/{id}/start` with `instance_id`.
7. **Immediately** and on **`SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS`**, **agent** sends mid-job heartbeats with `active_job_id` + `instance_id`. If the response includes `active_job_lease.extended === false`, the agent **stops**: it aborts `first-audit.sh` (if running), **does not upload**, and `POST …/fail` with code **`lease_not_extended`** so the job is not left ambiguously “running” on the client side.
8. **Agent** runs **`bash first-audit.sh`** with `cwd` = `SIGNALFORGE_COLLECTORS_DIR`, then requires a **`server_audit_YYYYMMDD_HHMMSS.log` that is new or has a newer mtime than before the run** (refuses stale files). Or uses `SIGNALFORGE_AGENT_ARTIFACT_FILE`.
9. **Another** mid-job heartbeat runs **immediately before** `POST …/artifact` to catch lease loss after a long collection.
10. **Agent** `POST /api/collection-jobs/{id}/artifact` with multipart `file` + form field `instance_id`.
11. On collector or upload failure, **agent** `POST …/fail` with `instance_id`, `code` (`collector_failed`, `agent_failed`, or `lease_not_extended`), and `message`. stderr includes server error bodies when available.

Contract details: SignalForge [`plans/phase-6b-source-job-api-contract.md`](https://github.com/Canepro/signalforge/blob/main/plans/phase-6b-source-job-api-contract.md), [`docs/api-contract.md`](https://github.com/Canepro/signalforge/blob/main/docs/api-contract.md).

## Collector invocation

- **No** audit logic lives in this repo.
- The agent only spawns `first-audit.sh` from **signalforge-collectors** (or uploads an override file). It snapshots existing `server_audit_*.log` files before the script and only accepts a log that appeared or was updated by that run.
- To change *how* evidence is gathered, edit **signalforge-collectors**, not this agent.

## Limitations (v0.1)

- One **source** per token; one **active job** at a time per process.
- **Linux / WSL** only; `linux-audit-log` only.
- No realtime push/broker; bounded long-poll only.
- No token rotation, notifications, or multi-source agents.

## Run As A Service

For normal operator use, prefer a long-running service over repeated manual `once` calls.

Example `systemd` unit:

```ini
/home/vincent/src/signalforge-agent/contrib/systemd/signalforge-agent.service
```

Then:

```bash
sudo cp contrib/systemd/signalforge-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signalforge-agent
sudo systemctl status signalforge-agent
```

If you want fixed-time scheduled collection instead, use cron or a systemd timer with `signalforge-agent once`, but that is less responsive for operator-triggered “collect now” requests because queued jobs wait until the next invocation.

## Development

```bash
bun test
bun run typecheck
```

## License

MIT
