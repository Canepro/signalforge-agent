# Low-traffic cost control

Use this profile for continuously running agents that serve low-use SignalForge
environments where control-plane scale-to-zero savings matter more than immediate
idle-job pickup.

## Profile

Set the same values on every execution agent that should share the wake window:

```dotenv
SIGNALFORGE_POLL_INTERVAL_MS=900000
SIGNALFORGE_POLL_ALIGNMENT_MS=900000
SIGNALFORGE_MAX_BACKOFF_MS=900000
SIGNALFORGE_JOBS_WAIT_SECONDS=20
```

`900000` milliseconds is 15 minutes. The alignment uses Unix wall-clock
boundaries, so this profile schedules successful idle cycles on UTC quarter-hour
boundaries. An agent still runs one cycle immediately when its process starts.
After an empty cycle, it sleeps until the next boundary instead of drifting 15
minutes from its own start time.

The four settings have separate roles:

- `SIGNALFORGE_POLL_INTERVAL_MS` is the unaligned idle sleep, claim-conflict
  delay, and starting delay for transient retries.
- `SIGNALFORGE_POLL_ALIGNMENT_MS` coordinates the next empty cycle or
  claim-conflict retry when enabled.
- `SIGNALFORGE_MAX_BACKOFF_MS` caps retry delay after transient API or network
  failures. Retry backoff is not wall-clock aligned.
- `SIGNALFORGE_JOBS_WAIT_SECONDS` keeps each jobs request open for up to 20
  seconds, which is the API maximum.

Keep the alignment and max backoff greater than or equal to the poll interval.
`signalforge-agent preflight` rejects an invalid combination.

## Why it reduces cost

Each idle cycle sends a heartbeat, opens a bounded jobs poll, and checks for fix
actions. Frequent cycles can repeatedly wake a control plane that would otherwise
scale to zero. Aligning low-use agents groups those requests into the same
quarter-hour activation window and gives the control plane a longer quiet period
between windows.

This is a latency and recovery tradeoff. With this profile, a job queued outside
an open long-poll window can wait up to about 15 minutes for an idle agent to
start the next heartbeat and poll cycle, plus normal network and cold-start
overhead. A job queued while the 20-second long poll is open can be returned
immediately. Once the agent receives work, claim, collection, upload, and lease
heartbeats use their normal timing. The alignment delay applies after an empty
cycle or claim conflict, not after completed work or during transient-error
backoff.

## Freshness semantics

Interpret freshness at the correct layer:

- Agent heartbeat or last-seen freshness advances when the agent wakes. An age
  within the configured 15-minute idle interval is expected and does not by
  itself mean the service is stopped.
- Evidence freshness advances only after a new collection completes and its
  artifact is uploaded. A queued job, an idle heartbeat, or an empty poll does
  not make existing evidence fresh.
- Job freshness is request latency. With a healthy API and no claim contention,
  budget for up to 15 minutes before an idle agent's first claim attempt. After
  claim, use the normal job and lease state to judge progress.

Do not change control-plane health thresholds or evidence-age policy merely to
hide the longer cadence. Those policies should state which freshness layer they
measure.

## Apply and verify

Update the service's existing environment source and restart or roll out that
service through its normal supervisor. Do not move tokens or other runtime paths
as part of this change.

Before restart, run:

```bash
signalforge-agent preflight
bun test
bun run typecheck
```

Preflight should report:

```text
Backoff: base 900000ms, max 900000ms
Idle poll alignment: 900000ms
```

After restart, check the supervisor and logs. A healthy idle agent reports the
configured alignment at loop start, then reports the next UTC boundary after an
empty cycle:

```text
poll loop started (... wall-clock alignment 900000ms)
no queued job (...)
next idle poll aligned at 2026-07-19T18:30:00.000Z
```

The completed 2026-07-19 rollout provided the following portable proof:

- implementation commits `53a66c9` and `bdf0f4c` were present on `origin/main`
- three execution agents refreshed within 128 ms of each other at
  `2026-07-19T18:15:27Z` after a cold wake, then each aligned its next idle poll
  to `2026-07-19T18:30:00Z`
- the control plane was at zero replicas before the wake and returned to zero at
  `2026-07-19T18:21:12Z`
- 59 tests and the TypeScript check passed
- the two macOS services remained running, and the remote Linux service remained
  active with zero restarts

Private deployment identities, hostnames, credentials, and token paths are
intentionally kept in the private infrastructure record, not this repository.

## Roll back the cadence

The alignment feature is opt-in, so rollback is configuration-only. Restore the
normal responsive profile and remove the alignment variable:

```dotenv
SIGNALFORGE_POLL_INTERVAL_MS=30000
# Remove SIGNALFORGE_POLL_ALIGNMENT_MS from the service environment.
SIGNALFORGE_MAX_BACKOFF_MS=300000
SIGNALFORGE_JOBS_WAIT_SECONDS=20
```

Restart or roll out the service through its normal supervisor. Then verify that
preflight reports `Idle poll alignment: off`, the startup log reports
`wall-clock alignment off`, and the service remains healthy. This rollback
increases idle control-plane wake frequency and restores the normal roughly
30-second idle pickup cadence.
