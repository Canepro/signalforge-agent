import type { AgentConfig } from "./config.ts";
import {
  ApiError,
  createClient,
  type FetchLike,
  type SignalForgeAgentClient,
} from "./api.ts";
import { CollectorError, runFirstAuditScript } from "./collector.ts";
import { logError, logInfo, logWarn } from "./log.ts";

const CAPABILITIES = ["collect:linux-audit-log", "upload:multipart"] as const;
const LEASE_TTL_SECONDS = 300;
const LEASE_FAIL_CODE = "lease_not_extended";

export type IdleHeartbeatResult = {
  gate: string | null;
  jobs: unknown[];
};

export type ProcessJobResult =
  | { kind: "processed"; jobId: string; runStatus?: string; analysisStatus?: string }
  | { kind: "noop"; reason: "no_job"; gate: string | null }
  | { kind: "error"; code: number; message: string };

/**
 * Server rejected lease extension for the active job — stop work and do not upload.
 */
function isLeaseExtensionRejected(hb: Record<string, unknown>): boolean {
  const lease = hb.active_job_lease;
  if (!lease || typeof lease !== "object") return false;
  return (lease as Record<string, unknown>).extended === false;
}

function leaseRejectDetail(hb: Record<string, unknown>): string | null {
  const lease = hb.active_job_lease;
  if (!lease || typeof lease !== "object") return null;
  const code = (lease as Record<string, unknown>).code;
  return code != null ? String(code) : null;
}

/**
 * Heartbeat (idle) + jobs/next. Does not claim.
 */
export async function idleHeartbeatAndPoll(
  client: SignalForgeAgentClient,
  cfg: AgentConfig
): Promise<IdleHeartbeatResult> {
  await client.heartbeat({
    capabilities: [...CAPABILITIES],
    attributes: { agent: "signalforge-agent", runtime: "bun" },
    agent_version: cfg.agentVersion,
    active_job_id: null,
  });

  const { jobs, gate } = await client.jobsNext(1);
  return { gate, jobs };
}

function jobIdFromSummary(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function midJobHeartbeatBody(
  cfg: AgentConfig,
  jobId: string,
  instanceId: string
) {
  return {
    capabilities: [...CAPABILITIES],
    attributes: { agent: "signalforge-agent", runtime: "bun" },
    agent_version: cfg.agentVersion,
    active_job_id: jobId,
    instance_id: instanceId,
  };
}

/**
 * Claim → start → collect → artifact (or fail). Assumes idle heartbeat already satisfied gating.
 */
export async function processOneQueuedJob(
  client: SignalForgeAgentClient,
  cfg: AgentConfig,
  jobId: string
): Promise<ProcessJobResult> {
  const { instanceId } = cfg;

  try {
    await client.claim(jobId, instanceId, LEASE_TTL_SECONDS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.status === 409) {
      return { kind: "error", code: 5, message: `claim conflict: ${msg}` };
    }
    return { kind: "error", code: 4, message: `claim failed: ${msg}` };
  }

  logInfo(`claimed job ${jobId}`);

  try {
    await client.start(jobId, instanceId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "error", code: 4, message: `start failed: ${msg}` };
  }

  logInfo(`started job ${jobId}`);

  const leaseAbort = new AbortController();
  let leaseNotExtended = false;
  let leaseRejectCode: string | null = null;
  let leaseFailureReported = false;

  let leaseTimer: ReturnType<typeof setInterval> | undefined;

  const stopLeaseTimer = (): void => {
    if (leaseTimer !== undefined) {
      clearInterval(leaseTimer);
      leaseTimer = undefined;
    }
  };

  const markLeaseRejected = (hb: Record<string, unknown>): boolean => {
    if (!isLeaseExtensionRejected(hb)) return false;
    leaseRejectCode = leaseRejectDetail(hb);
    leaseNotExtended = true;
    logError(
      `lease not extended for job ${jobId} (server code=${leaseRejectCode ?? "?"}); stopping collection and blocking upload`
    );
    leaseAbort.abort();
    stopLeaseTimer();
    return true;
  };

  const reportLeaseLossToServer = async (): Promise<ProcessJobResult> => {
    const msg = `lease extension rejected by SignalForge${leaseRejectCode ? ` (${leaseRejectCode})` : ""}; not uploading`;
    if (!leaseFailureReported) {
      leaseFailureReported = true;
      try {
        await client.fail(jobId, instanceId, LEASE_FAIL_CODE, msg.slice(0, 2000));
        logInfo(`reported ${LEASE_FAIL_CODE} to SignalForge for job ${jobId}`);
      } catch (failErr) {
        logWarn(
          `could not POST fail for job ${jobId}: ${failErr instanceof Error ? failErr.message : String(failErr)}`
        );
      }
    }
    return { kind: "error", code: 4, message: msg };
  };

  try {
    const hb0 = await client.heartbeat(midJobHeartbeatBody(cfg, jobId, instanceId));
    if (markLeaseRejected(hb0 as Record<string, unknown>)) {
      return await reportLeaseLossToServer();
    }

    leaseTimer = setInterval(() => {
      void (async () => {
        try {
          const hb = await client.heartbeat(midJobHeartbeatBody(cfg, jobId, instanceId));
          markLeaseRejected(hb as Record<string, unknown>);
        } catch (err) {
          logWarn(
            `mid-job heartbeat failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })();
    }, cfg.leaseHeartbeatMs);

    let artifactPath: string;
    let uploadName: string;

    if (cfg.artifactFileOverride) {
      artifactPath = cfg.artifactFileOverride;
      uploadName = artifactPath.split(/[/\\]/).pop() || "artifact.log";
      logInfo(`using artifact override file: ${artifactPath}`);
    } else {
      artifactPath = await runFirstAuditScript(cfg.collectorsDir, {
        signal: leaseAbort.signal,
      });
      uploadName = artifactPath.split(/[/\\]/).pop() || "audit.log";
      logInfo(`collector produced: ${artifactPath}`);
    }

    if (leaseNotExtended) {
      return await reportLeaseLossToServer();
    }

    const hbBeforeUpload = await client.heartbeat(
      midJobHeartbeatBody(cfg, jobId, instanceId)
    );
    if (markLeaseRejected(hbBeforeUpload as Record<string, unknown>)) {
      return await reportLeaseLossToServer();
    }

    let upload: Record<string, unknown>;
    try {
      upload = await client.uploadArtifact(jobId, instanceId, artifactPath, uploadName);
    } catch (up) {
      if (
        up instanceof ApiError &&
        up.status === 409 &&
        up.bodyJson?.code === "job_already_submitted"
      ) {
        logInfo(`job ${jobId} already submitted — treating as success`);
        return { kind: "processed", jobId };
      }
      throw up;
    }
    const job = upload.job as Record<string, unknown> | undefined;
    const runStatus =
      typeof upload.run_status === "string" ? upload.run_status : undefined;
    const analysis =
      job && typeof job.result_analysis_status === "string" ?
        job.result_analysis_status
      : undefined;

    if (runStatus === "error" || analysis === "error") {
      logWarn(
        `job ${jobId} submitted but analysis reported error (run_status=${runStatus ?? "?"}, result_analysis_status=${analysis ?? "?"})`
      );
    } else {
      logInfo(`upload complete: run_id=${String(upload.run_id ?? "")} artifact_id=${String(upload.artifact_id ?? "")}`);
    }

    return {
      kind: "processed",
      jobId,
      runStatus,
      analysisStatus: analysis,
    };
  } catch (e) {
    if (leaseNotExtended) {
      return await reportLeaseLossToServer();
    }
    const msg = e instanceof Error ? e.message : String(e);
    const isCollector = e instanceof CollectorError;
    try {
      await client.fail(
        jobId,
        instanceId,
        isCollector ? "collector_failed" : "agent_failed",
        msg.slice(0, 2000)
      );
      logInfo(`reported failure to SignalForge for job ${jobId}`);
    } catch (failErr) {
      logWarn(`could not POST fail for job ${jobId}: ${failErr instanceof Error ? failErr.message : String(failErr)}`);
    }
    return {
      kind: "error",
      code: isCollector ? 3 : 4,
      message: msg,
    };
  } finally {
    stopLeaseTimer();
  }
}

/**
 * Full cycle: idle heartbeat + poll; if a job exists, process it.
 */
export async function runSingleCycle(
  cfg: AgentConfig,
  fetchImpl?: FetchLike
): Promise<ProcessJobResult> {
  const client = createClient(cfg.baseUrl, cfg.agentToken, fetchImpl);

  const { gate, jobs } = await idleHeartbeatAndPoll(client, cfg);
  if (jobs.length === 0) {
    return { kind: "noop", reason: "no_job", gate };
  }

  const id = jobIdFromSummary(jobs[0]);
  if (!id) {
    return { kind: "error", code: 4, message: "jobs/next returned a row without id" };
  }

  return processOneQueuedJob(client, cfg, id);
}
