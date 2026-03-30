#!/usr/bin/env bun
/**
 * signalforge-agent — thin execution-plane CLI for SignalForge collection jobs.
 */

import { AuthError } from "./api.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { logError, logInfo, logWarn } from "./log.ts";
import { runSingleCycle } from "./job-runner.ts";
import { runPreflight } from "./preflight.ts";
import {
  isRetryableRunLoopError,
  isRetryableRunLoopResult,
  nextRetryDelayMs,
} from "./run-loop.ts";

const VERSION = "0.1.0";

export const EXIT = {
  OK: 0,
  USAGE: 1,
  AUTH: 2,
  COLLECTOR: 3,
  API: 4,
  CLAIM_CONFLICT: 5,
  CONFIG: 6,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp(): void {
  console.log(`signalforge-agent ${VERSION}

Execution-plane agent for SignalForge: heartbeat, poll, claim, dispatch collector scripts from signalforge-collectors, upload.

Usage:
  signalforge-agent once    Heartbeat + process at most one queued job, then exit
  signalforge-agent run     Poll loop (SIGNALFORGE_POLL_INTERVAL_MS between cycles)
  signalforge-agent preflight  Validate config and local collector/runtime readiness
  signalforge-agent help    Show this help
  signalforge-agent version Print version

Environment (see .env.example):
  SIGNALFORGE_URL / SIGNALFORGE_BASE_URL   SignalForge origin (no trailing slash)
  SIGNALFORGE_AGENT_TOKEN                Source-bound agent Bearer token
  SIGNALFORGE_AGENT_TOKEN_FILE           Optional file containing the source-bound token
  SIGNALFORGE_AGENT_INSTANCE_ID          Opaque stable id for this process
  SIGNALFORGE_COLLECTORS_DIR             Path to signalforge-collectors collector scripts
  SIGNALFORGE_AGENT_CAPABILITIES         Optional comma-separated heartbeat capabilities override
  SIGNALFORGE_POLL_INTERVAL_MS           Optional; default 30000 (run-mode backoff)
  SIGNALFORGE_MAX_BACKOFF_MS            Optional; default 300000 (run-mode transient error backoff ceiling)
  SIGNALFORGE_JOBS_WAIT_SECONDS          Optional; default 20, max 20 (run-mode long-poll)
  SIGNALFORGE_KUBECTL_BIN               Optional; override kubectl binary name or path
  SIGNALFORGE_KUBECONFIG                Optional; explicit kubeconfig path for the service
  SIGNALFORGE_AGENT_ARTIFACT_FILE        Optional; upload file instead of running collector
  SIGNALFORGE_AGENT_VERSION              Optional; reported to heartbeat (default ${VERSION})
  SIGNALFORGE_AGENT_UPLOAD_TRANSPORT     Optional; fetch or curl (default fetch)

Exit codes (once mode):
  0 success (job processed, or no queued job)
  1 usage
  2 authentication failed (HTTP 401)
  3 collector script failed / no fresh audit log / aborted
  4 lease not extended, other API / upload failure
  5 claim conflict (HTTP 409)
  6 configuration error
`);
}

async function cmdOnce(): Promise<number> {
  const cfg = loadConfig();
  try {
    const r = await runSingleCycle(cfg);
    if (r.kind === "noop") {
      logInfo(`no queued job (gate=${r.gate ?? "null"})`);
      return EXIT.OK;
    }
    if (r.kind === "processed") {
      logInfo(`job ${r.jobId} finished (run_status=${r.runStatus ?? "?"}, result_analysis_status=${r.analysisStatus ?? "?"})`);
      return EXIT.OK;
    }
    logError(r.message);
    return r.code;
  } catch (e) {
    if (e instanceof AuthError) {
      logError(`authentication failed: ${e.bodyText.slice(0, 300)}`);
      return EXIT.AUTH;
    }
    logError(e instanceof Error ? e.message : String(e));
    return EXIT.API;
  }
}

async function cmdRun(): Promise<number> {
  const cfg = loadConfig();
  let retryDelayMs = cfg.pollIntervalMs;
  logInfo(
    `poll loop started (long-poll ${cfg.jobsWaitSeconds}s, base backoff ${cfg.pollIntervalMs}ms, max backoff ${cfg.maxBackoffMs}ms)`
  );
  for (;;) {
    let shouldSleep = false;
    let retryable = false;
    try {
      const r = await runSingleCycle(cfg, undefined, {
        waitSeconds: cfg.jobsWaitSeconds,
      });
      if (r.kind === "noop") {
        logInfo(`no queued job (gate=${r.gate ?? "null"})`);
        shouldSleep = r.gate !== null;
        retryDelayMs = cfg.pollIntervalMs;
      } else if (r.kind === "processed") {
        logInfo(
          `job ${r.jobId} finished (run_status=${r.runStatus ?? "?"}, result_analysis_status=${r.analysisStatus ?? "?"})`
        );
        retryDelayMs = cfg.pollIntervalMs;
      } else {
        logError(r.message);
        shouldSleep = true;
        if (r.code === EXIT.CLAIM_CONFLICT) {
          logWarn("claim conflict — another worker may hold the lease; will retry after interval");
          retryDelayMs = cfg.pollIntervalMs;
        } else if (isRetryableRunLoopResult(r)) {
          retryable = true;
          logWarn("transient API failure — backing off before the next cycle");
        } else {
          return r.code;
        }
      }
    } catch (e) {
      if (e instanceof AuthError) {
        logError(`authentication failed: ${e.bodyText.slice(0, 300)}`);
        return EXIT.AUTH;
      }
      if (isRetryableRunLoopError(e)) {
        logWarn(`transient cycle error: ${e instanceof Error ? e.message : String(e)}`);
        shouldSleep = true;
        retryable = true;
      } else {
        logError(`cycle error: ${e instanceof Error ? e.message : String(e)}`);
        return EXIT.API;
      }
    }
    if (shouldSleep) {
      if (retryable) {
        const next = nextRetryDelayMs(retryDelayMs, cfg.maxBackoffMs);
        logWarn(`retrying after ${next.sleepMs}ms (max ${cfg.maxBackoffMs}ms)`);
        retryDelayMs = next.nextDelayMs;
        await sleep(next.sleepMs);
      } else {
        retryDelayMs = cfg.pollIntervalMs;
        await sleep(cfg.pollIntervalMs);
      }
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    printHelp();
    process.exit(argv[0] ? EXIT.OK : EXIT.USAGE);
  }

  if (cmd === "version" || cmd === "--version") {
    console.log(VERSION);
    process.exit(EXIT.OK);
  }

  try {
    let code: number;
    if (cmd === "once") {
      code = await cmdOnce();
    } else if (cmd === "run") {
      code = await cmdRun();
    } else if (cmd === "preflight") {
      code = runPreflight(argv.slice(1));
    } else {
      printHelp();
      code = EXIT.USAGE;
    }
    process.exit(code);
  } catch (e) {
    if (e instanceof ConfigError) {
      logError(e.message);
      process.exit(EXIT.CONFIG);
    }
    throw e;
  }
}

await main();
