import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AgentConfig {
  baseUrl: string;
  agentToken: string;
  instanceId: string;
  collectorsDir: string;
  capabilities: string[];
  pollIntervalMs: number;
  /** Bounded long-poll duration for jobs/next while running continuously (default 20s) */
  jobsWaitSeconds: number;
  /** When set, upload this file instead of running a collector script */
  artifactFileOverride: string | null;
  agentVersion: string;
  /** Mid-job lease heartbeats while collecting/uploading (default 45s) */
  leaseHeartbeatMs: number;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return v;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_JOBS_WAIT_SECONDS = 20;
const DEFAULT_LEASE_HEARTBEAT_MS = 45_000;
const DEFAULT_AGENT_VERSION = "0.1.0";

function hasExecutableOnPath(name: string): boolean {
  return Bun.which(name) != null;
}

function collectorsScriptExists(collectorsDir: string, script: string): boolean {
  return existsSync(join(collectorsDir, script));
}

function defaultCapabilitiesForEnvironment(
  collectorsDir: string,
  artifactFileOverride: string | null
): string[] {
  if (artifactFileOverride) {
    return ["upload:multipart"];
  }

  const capabilities: string[] = [];

  if (collectorsScriptExists(collectorsDir, "first-audit.sh")) {
    capabilities.push("collect:linux-audit-log");
  }

  const containerRef = process.env.SIGNALFORGE_CONTAINER_REF?.trim();
  if (
    containerRef &&
    collectorsScriptExists(collectorsDir, "collect-container-diagnostics.sh") &&
    (hasExecutableOnPath("podman") || hasExecutableOnPath("docker"))
  ) {
    capabilities.push("collect:container-diagnostics");
  }

  if (
    collectorsScriptExists(collectorsDir, "collect-kubernetes-bundle.sh") &&
    hasExecutableOnPath(process.env.SIGNALFORGE_KUBECTL_BIN?.trim() || "kubectl")
  ) {
    capabilities.push("collect:kubernetes-bundle");
  }

  capabilities.push("upload:multipart");
  return capabilities;
}

function parseCapabilityList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

/**
 * Load config from environment. Uses SIGNALFORGE_URL or SIGNALFORGE_BASE_URL.
 */
export function loadConfig(): AgentConfig {
  const baseRaw =
    process.env.SIGNALFORGE_URL?.trim() || process.env.SIGNALFORGE_BASE_URL?.trim();
  if (!baseRaw) {
    throw new ConfigError("Set SIGNALFORGE_URL (or SIGNALFORGE_BASE_URL)");
  }
  const baseUrl = baseRaw.replace(/\/+$/, "");

  const agentToken = requireEnv("SIGNALFORGE_AGENT_TOKEN");
  const instanceId = requireEnv("SIGNALFORGE_AGENT_INSTANCE_ID");

  const override = process.env.SIGNALFORGE_AGENT_ARTIFACT_FILE?.trim() || null;
  let collectorsDir = process.env.SIGNALFORGE_COLLECTORS_DIR?.trim() || "";
  if (!override && !collectorsDir) {
    throw new ConfigError(
      "Set SIGNALFORGE_COLLECTORS_DIR (path to signalforge-collectors root), or SIGNALFORGE_AGENT_ARTIFACT_FILE for test override"
    );
  }
  if (collectorsDir) {
    collectorsDir = resolve(collectorsDir);
  }

  const pollRaw = process.env.SIGNALFORGE_POLL_INTERVAL_MS?.trim();
  let pollIntervalMs = DEFAULT_POLL_MS;
  if (pollRaw) {
    const n = parseInt(pollRaw, 10);
    if (Number.isNaN(n) || n < 1000) {
      throw new ConfigError("SIGNALFORGE_POLL_INTERVAL_MS must be an integer >= 1000");
    }
    pollIntervalMs = n;
  }

  const waitRaw = process.env.SIGNALFORGE_JOBS_WAIT_SECONDS?.trim();
  let jobsWaitSeconds = DEFAULT_JOBS_WAIT_SECONDS;
  if (waitRaw) {
    const n = parseInt(waitRaw, 10);
    if (Number.isNaN(n) || n < 0 || n > 20) {
      throw new ConfigError("SIGNALFORGE_JOBS_WAIT_SECONDS must be an integer between 0 and 20");
    }
    jobsWaitSeconds = n;
  }

  const agentVersion =
    process.env.SIGNALFORGE_AGENT_VERSION?.trim() || DEFAULT_AGENT_VERSION;

  const capabilitiesRaw = process.env.SIGNALFORGE_AGENT_CAPABILITIES?.trim();
  const capabilities =
    capabilitiesRaw ?
      parseCapabilityList(capabilitiesRaw)
    : defaultCapabilitiesForEnvironment(collectorsDir, override);
  if (capabilities.length === 0) {
    throw new ConfigError("SIGNALFORGE_AGENT_CAPABILITIES must not be empty");
  }

  const leaseRaw = process.env.SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS?.trim();
  let leaseHeartbeatMs = DEFAULT_LEASE_HEARTBEAT_MS;
  if (leaseRaw) {
    const n = parseInt(leaseRaw, 10);
    if (Number.isNaN(n) || n < 1000) {
      throw new ConfigError(
        "SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS must be an integer >= 1000"
      );
    }
    leaseHeartbeatMs = n;
  }

  return {
    baseUrl,
    agentToken,
    instanceId,
    collectorsDir,
    capabilities,
    pollIntervalMs,
    jobsWaitSeconds,
    artifactFileOverride: override ? resolve(override) : null,
    agentVersion,
    leaseHeartbeatMs,
  };
}
