#!/usr/bin/env bun
/**
 * signalforge-agent — thin execution-plane CLI for SignalForge collection jobs.
 */

import { AuthError } from "./api.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { formatDiscoverySummary, fetchDiscoverySnapshot } from "./discovery.ts";
import { EnrollError, enrollCollectionAgent } from "./enroll.ts";
import { logError, logInfo, logWarn } from "./log.ts";
import { runSingleCycle } from "./job-runner.ts";
import { runPreflight } from "./preflight.ts";
import {
  isRetryableRunLoopError,
  isRetryableRunLoopResult,
  nextRetryDelayMs,
  nextWallClockBoundaryDelayMs,
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
  ENROLL_CONFLICT: 7,
} as const;

function loadBaseUrlFromEnv(): string {
  const baseRaw =
    process.env.SIGNALFORGE_BASE_URL?.trim() || process.env.SIGNALFORGE_URL?.trim();
  if (!baseRaw) {
    throw new ConfigError("Set SIGNALFORGE_BASE_URL (or SIGNALFORGE_URL)");
  }
  return baseRaw.replace(/\/+$/, "");
}

function readFlagValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1]?.trim();
  return value || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp(): void {
  console.log(`signalforge-agent ${VERSION}

Execution-plane agent for SignalForge: heartbeat, poll, claim, dispatch collector scripts from signalforge-collectors, upload.

Usage:
  signalforge-agent once    Heartbeat + process at most one queued job, then exit
  signalforge-agent run     Poll loop (SIGNALFORGE_POLL_INTERVAL_MS between cycles)
  signalforge-agent discover Fetch auth.md + well-known registration metadata
  signalforge-agent enroll  Operator-time registration via POST /agent/auth (admin Bearer)
  signalforge-agent preflight  Validate config and local collector/runtime readiness
  signalforge-agent help    Show this help
  signalforge-agent version Print version

Environment (see .env.example):
  SIGNALFORGE_BASE_URL / SIGNALFORGE_URL   SignalForge origin (no trailing slash; use ACA URL for long-lived agents)
  SIGNALFORGE_ADMIN_TOKEN                  Operator Bearer for enroll only (install/setup; not used by run/once)
  SIGNALFORGE_AGENT_TOKEN                Source-bound agent Bearer token
  SIGNALFORGE_AGENT_TOKEN_FILE           Optional file containing the source-bound token
  SIGNALFORGE_AGENT_INSTANCE_ID          Opaque stable id for this process
  SIGNALFORGE_COLLECTORS_DIR             Path to signalforge-collectors collector scripts
  SIGNALFORGE_AGENT_CAPABILITIES         Optional comma-separated heartbeat capabilities override
  SIGNALFORGE_POLL_INTERVAL_MS           Optional; default 30000 (run-mode backoff)
  SIGNALFORGE_POLL_ALIGNMENT_MS          Optional wall-clock interval for coordinated idle polling
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
  7 enroll conflict (source already registered)
`);
}

async function cmdDiscover(): Promise<number> {
  const baseUrl = loadBaseUrlFromEnv();
  const snapshot = await fetchDiscoverySnapshot(baseUrl);
  console.log(formatDiscoverySummary(snapshot));
  return EXIT.OK;
}

async function cmdEnroll(argv: string[]): Promise<number> {
  const baseUrl = readFlagValue(argv, "--base-url") ?? loadBaseUrlFromEnv();
  const sourceId = readFlagValue(argv, "--source-id");
  if (!sourceId) {
    logError("enroll requires --source-id <uuid>");
    return EXIT.USAGE;
  }

  const adminToken =
    readFlagValue(argv, "--admin-token") ??
    process.env.SIGNALFORGE_ADMIN_TOKEN?.trim() ??
    "";
  if (!adminToken) {
    logError("Set SIGNALFORGE_ADMIN_TOKEN or pass --admin-token for enroll");
    return EXIT.CONFIG;
  }

  const displayName = readFlagValue(argv, "--display-name");
  const tokenFile =
    readFlagValue(argv, "--token-file") ??
    process.env.SIGNALFORGE_AGENT_TOKEN_FILE?.trim() ??
    null;
  const printToken = argv.includes("--print-token");

  try {
    const result = await enrollCollectionAgent({
      baseUrl,
      sourceId,
      displayName,
      adminToken,
      tokenFile,
      printToken,
    });
    logInfo(`enrolled agent_id=${result.agentId} source_id=${result.sourceId}`);
    logInfo(`register_uri=${result.registerUri}`);
    logInfo(`token_prefix=${result.tokenPrefix}`);
    if (result.scopes.length > 0) {
      logInfo(`scopes=${result.scopes.join(",")}`);
    }
    if (result.tokenFile) {
      logInfo(`token_file=${result.tokenFile}`);
      logInfo("Set SIGNALFORGE_AGENT_TOKEN_FILE to this path for run/once/preflight");
    } else if (!printToken) {
      logWarn("Token not written to disk. Pass --token-file or --print-token, then configure SIGNALFORGE_AGENT_TOKEN or SIGNALFORGE_AGENT_TOKEN_FILE.");
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof EnrollError) {
      logError(e.message);
      if (e.code === "source_already_registered") return EXIT.ENROLL_CONFLICT;
      if (e.code === "admin_auth_failed") return EXIT.AUTH;
      return EXIT.API;
    }
    logError(e instanceof Error ? e.message : String(e));
    return EXIT.API;
  }
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
    if (r.kind === "processed_fix_action") {
      logInfo(`fix action ${r.actionRunId} finished`);
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
    `poll loop started (long-poll ${cfg.jobsWaitSeconds}s, base backoff ${cfg.pollIntervalMs}ms, max backoff ${cfg.maxBackoffMs}ms, wall-clock alignment ${cfg.pollAlignmentMs === null ? "off" : `${cfg.pollAlignmentMs}ms`})`
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
        shouldSleep = true;
        retryDelayMs = cfg.pollIntervalMs;
      } else if (r.kind === "processed") {
        logInfo(
          `job ${r.jobId} finished (run_status=${r.runStatus ?? "?"}, result_analysis_status=${r.analysisStatus ?? "?"})`
        );
        retryDelayMs = cfg.pollIntervalMs;
      } else if (r.kind === "processed_fix_action") {
        logInfo(`fix action ${r.actionRunId} finished`);
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
        const sleepMs =
          cfg.pollAlignmentMs === null ?
            cfg.pollIntervalMs
          : nextWallClockBoundaryDelayMs(Date.now(), cfg.pollAlignmentMs);
        if (cfg.pollAlignmentMs !== null) {
          logInfo(`next idle poll aligned at ${new Date(Date.now() + sleepMs).toISOString()}`);
        }
        await sleep(sleepMs);
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
    } else if (cmd === "discover") {
      code = await cmdDiscover();
    } else if (cmd === "enroll") {
      code = await cmdEnroll(argv.slice(1));
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
