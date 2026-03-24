#!/usr/bin/env bun
/**
 * signalforge-agent — thin execution-plane CLI for SignalForge collection jobs.
 */

import { AuthError } from "./api.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { logError, logInfo, logWarn } from "./log.ts";
import { runSingleCycle } from "./job-runner.ts";

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

Execution-plane agent for SignalForge: heartbeat, poll, claim, run signalforge-collectors, upload.

Usage:
  signalforge-agent once    Heartbeat + process at most one queued job, then exit
  signalforge-agent run     Poll loop (SIGNALFORGE_POLL_INTERVAL_MS between cycles)
  signalforge-agent help    Show this help
  signalforge-agent version Print version

Environment (see .env.example):
  SIGNALFORGE_URL / SIGNALFORGE_BASE_URL   SignalForge origin (no trailing slash)
  SIGNALFORGE_AGENT_TOKEN                Source-bound agent Bearer token
  SIGNALFORGE_AGENT_INSTANCE_ID          Opaque stable id for this process
  SIGNALFORGE_COLLECTORS_DIR             Path to signalforge-collectors (first-audit.sh)
  SIGNALFORGE_POLL_INTERVAL_MS           Optional; default 30000 (run mode)
  SIGNALFORGE_AGENT_ARTIFACT_FILE        Optional; upload file instead of running collector
  SIGNALFORGE_AGENT_VERSION              Optional; reported to heartbeat (default ${VERSION})

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
  logInfo(`poll loop started (interval ${cfg.pollIntervalMs}ms)`);
  for (;;) {
    try {
      const r = await runSingleCycle(cfg);
      if (r.kind === "noop") {
        logInfo(`no queued job (gate=${r.gate ?? "null"})`);
      } else if (r.kind === "processed") {
        logInfo(
          `job ${r.jobId} finished (run_status=${r.runStatus ?? "?"}, result_analysis_status=${r.analysisStatus ?? "?"})`
        );
      } else {
        logError(r.message);
        if (r.code === EXIT.CLAIM_CONFLICT) {
          logWarn("claim conflict — another worker may hold the lease; will retry after interval");
        } else {
          return r.code;
        }
      }
    } catch (e) {
      if (e instanceof AuthError) {
        logError(`authentication failed: ${e.bodyText.slice(0, 300)}`);
        return EXIT.AUTH;
      }
      logError(`cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(cfg.pollIntervalMs);
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
