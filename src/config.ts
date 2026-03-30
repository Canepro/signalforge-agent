import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { UploadTransport } from "./api.ts";

export interface AgentConfig {
  baseUrl: string;
  agentToken: string;
  agentTokenSource: "env" | "file";
  agentTokenFile: string | null;
  instanceId: string;
  collectorsDir: string;
  collectorWorkdir: string;
  containerRuntime: "docker" | "podman" | null;
  containerRuntimeReason: string;
  kubectlBin: string;
  kubeconfigPath: string | null;
  capabilities: string[];
  pollIntervalMs: number;
  maxBackoffMs: number;
  /** Bounded long-poll duration for jobs/next while running continuously (default 20s) */
  jobsWaitSeconds: number;
  /** When set, upload this file instead of running a collector script */
  artifactFileOverride: string | null;
  agentVersion: string;
  uploadTransport: UploadTransport;
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
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const DEFAULT_JOBS_WAIT_SECONDS = 20;
const DEFAULT_LEASE_HEARTBEAT_MS = 45_000;
const DEFAULT_AGENT_VERSION = "0.1.0";
const DEFAULT_UPLOAD_TRANSPORT: UploadTransport = "fetch";

export interface RuntimeCapabilityCheck {
  capability: Exclude<AgentConfig["capabilities"][number], "upload:multipart">;
  enabled: boolean;
  reason: string;
}

export interface RuntimeEnvironmentHints {
  kubectlBin: string;
  kubeconfigPath: string | null;
  containerRuntime: "docker" | "podman" | null;
  containerRuntimeReason: string;
}

interface RuntimeHintOptions {
  probeContainerRuntime: boolean;
}

const RUNTIME_PROBE_TIMEOUT_MS = 1_500;

function resolveExecutableOnPath(name: string): string | null {
  if (name.includes("/")) {
    const directPath = resolve(name);
    return isExecutableFile(directPath) ? directPath : null;
  }
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    const mode = stats.mode & 0o111;
    if (process.platform === "win32") return mode !== 0 || path.toLowerCase().endsWith(".exe");
    return mode !== 0;
  } catch {
    return false;
  }
}

function hasExecutableOnPath(name: string): boolean {
  return resolveExecutableOnPath(name) !== null;
}

function collectorsScriptExists(collectorsDir: string, script: string): boolean {
  return existsSync(join(collectorsDir, script));
}

export function runtimeCapabilityChecksForEnvironment(
  collectorsDir: string,
  artifactFileOverride: string | null,
  hints: RuntimeEnvironmentHints
): RuntimeCapabilityCheck[] {
  if (artifactFileOverride) {
    return [
      {
        capability: "collect:linux-audit-log",
        enabled: false,
        reason: "artifact override mode skips collector dispatch",
      },
      {
        capability: "collect:container-diagnostics",
        enabled: false,
        reason: "artifact override mode skips collector dispatch",
      },
      {
        capability: "collect:kubernetes-bundle",
        enabled: false,
        reason: "artifact override mode skips collector dispatch",
      },
    ];
  }

  const hasLinuxScript = collectorsScriptExists(collectorsDir, "first-audit.sh");
  const hasContainerScript = collectorsScriptExists(
    collectorsDir,
    "collect-container-diagnostics.sh"
  );
  const hasKubernetesScript = collectorsScriptExists(
    collectorsDir,
    "collect-kubernetes-bundle.sh"
  );
  const hasKubectl = hasExecutableOnPath(hints.kubectlBin);

  return [
    {
      capability: "collect:linux-audit-log",
      enabled: hasLinuxScript,
      reason:
        hasLinuxScript ? "first-audit.sh found" : "missing first-audit.sh in collectors dir",
    },
    {
      capability: "collect:container-diagnostics",
      enabled: hasContainerScript && hints.containerRuntime !== null,
      reason:
        !hasContainerScript ? "missing collect-container-diagnostics.sh in collectors dir"
        : hints.containerRuntimeReason,
    },
    {
      capability: "collect:kubernetes-bundle",
      enabled: hasKubernetesScript && hasKubectl,
      reason:
        !hasKubernetesScript ? "missing collect-kubernetes-bundle.sh in collectors dir"
        : hasKubectl ?
          hints.kubeconfigPath ?
            `kubectl binary found (${hints.kubectlBin}); kubeconfig set (${hints.kubeconfigPath})`
          : `kubectl binary found (${hints.kubectlBin}); using ambient/default kube context`
        : `missing kubectl binary on PATH (${hints.kubectlBin})`,
    },
  ];
}

function defaultCapabilitiesForEnvironment(
  collectorsDir: string,
  artifactFileOverride: string | null,
  hints: RuntimeEnvironmentHints
): string[] {
  return [
    ...runtimeCapabilityChecksForEnvironment(collectorsDir, artifactFileOverride, hints)
      .filter((check) => check.enabled)
      .map((check) => check.capability),
    "upload:multipart",
  ];
}

function parseCapabilityList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

function summarizeProbeFailure(output: string): string {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "no diagnostic output";
  return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

function probeContainerRuntime(runtime: "docker" | "podman"): {
  ok: boolean;
  reason: string;
} {
  const runtimePath = resolveExecutableOnPath(runtime);
  if (!runtimePath) {
    return {
      ok: false,
      reason: `missing ${runtime} binary on PATH`,
    };
  }

  const probeArgs =
    runtime === "docker" ?
      ["info"]
    : ["info", "--format", "json"];
  const result = spawnSync(runtimePath, probeArgs, {
    encoding: "utf8",
    timeout: RUNTIME_PROBE_TIMEOUT_MS,
  });

  if (result.error) {
    const timeoutLike =
      result.error.name === "TimeoutError" ||
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const errorMessage =
      timeoutLike ? "runtime probe timed out"
      : result.error.message;
    return {
      ok: false,
      reason: `${runtime} found but not usable: ${errorMessage}`,
    };
  }

  if (result.status === 0) {
    return {
      ok: true,
      reason: `${runtime} runtime accessible`,
    };
  }

  const combinedOutput = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return {
    ok: false,
    reason: `${runtime} found but not usable: ${summarizeProbeFailure(combinedOutput)}`,
  };
}

function loadAgentToken(): {
  token: string;
  source: "env" | "file";
  tokenFile: string | null;
} {
  const envToken = process.env.SIGNALFORGE_AGENT_TOKEN?.trim() || "";
  if (envToken) {
    return {
      token: envToken,
      source: "env",
      tokenFile: null,
    };
  }

  const tokenFileRaw = process.env.SIGNALFORGE_AGENT_TOKEN_FILE?.trim() || "";
  if (!tokenFileRaw) {
    throw new ConfigError(
      "Set SIGNALFORGE_AGENT_TOKEN or SIGNALFORGE_AGENT_TOKEN_FILE"
    );
  }

  const tokenFile = resolve(tokenFileRaw);
  let token = "";
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch (error) {
    throw new ConfigError(
      `Could not read SIGNALFORGE_AGENT_TOKEN_FILE: ${tokenFile} (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!token) {
    throw new ConfigError(
      `SIGNALFORGE_AGENT_TOKEN_FILE is empty: ${tokenFile}`
    );
  }
  return {
    token,
    source: "file",
    tokenFile,
  };
}

function loadRuntimeEnvironmentHints(
  options: RuntimeHintOptions
): RuntimeEnvironmentHints {
  const kubectlBin = process.env.SIGNALFORGE_KUBECTL_BIN?.trim() || "kubectl";
  const kubeconfigRaw =
    process.env.SIGNALFORGE_KUBECONFIG?.trim() || process.env.KUBECONFIG?.trim() || "";
  const kubeconfigPath = kubeconfigRaw ? resolve(kubeconfigRaw) : null;
  if (kubeconfigPath && !existsSync(kubeconfigPath)) {
    throw new ConfigError(`Configured kubeconfig does not exist: ${kubeconfigPath}`);
  }
  if (kubeconfigPath) {
    process.env.KUBECONFIG = kubeconfigPath;
  }

  if (!options.probeContainerRuntime) {
    const containerRuntime =
      resolveExecutableOnPath("docker") ? "docker"
      : resolveExecutableOnPath("podman") ? "podman"
      : null;
    return {
      kubectlBin,
      kubeconfigPath,
      containerRuntime,
      containerRuntimeReason:
        containerRuntime ?
          `${containerRuntime} binary found (runtime access not probed)`
        : "missing container runtime binary on PATH (docker or podman)",
    };
  }

  const dockerProbe = probeContainerRuntime("docker");
  const podmanProbe = probeContainerRuntime("podman");
  const accessibleRuntime =
    dockerProbe.ok ? "docker"
    : podmanProbe.ok ? "podman"
    : null;

  return {
    kubectlBin,
    kubeconfigPath,
    containerRuntime: accessibleRuntime,
    containerRuntimeReason:
      dockerProbe.ok ? dockerProbe.reason
      : podmanProbe.ok ? podmanProbe.reason
      : !dockerProbe.ok && dockerProbe.reason !== "missing docker binary on PATH" ? dockerProbe.reason
      : !podmanProbe.ok && podmanProbe.reason !== "missing podman binary on PATH" ? podmanProbe.reason
      : "missing container runtime binary on PATH (docker or podman)",
  };
}

/**
 * Load config from environment. Uses SIGNALFORGE_URL or SIGNALFORGE_BASE_URL.
 */
export function loadConfig(options: { probeRuntimeReadiness?: boolean } = {}): AgentConfig {
  const baseRaw =
    process.env.SIGNALFORGE_URL?.trim() || process.env.SIGNALFORGE_BASE_URL?.trim();
  if (!baseRaw) {
    throw new ConfigError("Set SIGNALFORGE_URL (or SIGNALFORGE_BASE_URL)");
  }
  const baseUrl = baseRaw.replace(/\/+$/, "");

  const token = loadAgentToken();
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
  const collectorWorkdirRaw = process.env.SIGNALFORGE_AGENT_WORKDIR?.trim() || "";
  const collectorWorkdir = resolve(collectorWorkdirRaw || collectorsDir);
  if (!override) {
    try {
      mkdirSync(collectorWorkdir, { recursive: true });
    } catch (error) {
      throw new ConfigError(
        `Could not create or access SIGNALFORGE_AGENT_WORKDIR: ${collectorWorkdir} (${error instanceof Error ? error.message : String(error)})`
      );
    }
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

  const maxBackoffRaw = process.env.SIGNALFORGE_MAX_BACKOFF_MS?.trim();
  let maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
  if (maxBackoffRaw) {
    const n = parseInt(maxBackoffRaw, 10);
    if (Number.isNaN(n) || n < 1000) {
      throw new ConfigError("SIGNALFORGE_MAX_BACKOFF_MS must be an integer >= 1000");
    }
    maxBackoffMs = n;
  }
  if (maxBackoffMs < pollIntervalMs) {
    throw new ConfigError(
      "SIGNALFORGE_MAX_BACKOFF_MS must be greater than or equal to SIGNALFORGE_POLL_INTERVAL_MS"
    );
  }

  const agentVersion =
    process.env.SIGNALFORGE_AGENT_VERSION?.trim() || DEFAULT_AGENT_VERSION;
  const uploadTransportRaw =
    process.env.SIGNALFORGE_AGENT_UPLOAD_TRANSPORT?.trim() || DEFAULT_UPLOAD_TRANSPORT;
  if (uploadTransportRaw !== "fetch" && uploadTransportRaw !== "curl") {
    throw new ConfigError(
      "SIGNALFORGE_AGENT_UPLOAD_TRANSPORT must be fetch or curl"
    );
  }
  const uploadTransport = uploadTransportRaw;

  const capabilitiesRaw = process.env.SIGNALFORGE_AGENT_CAPABILITIES?.trim();
  const runtimeHints = loadRuntimeEnvironmentHints({
    probeContainerRuntime:
      options.probeRuntimeReadiness === true || (!capabilitiesRaw && !override),
  });
  const capabilities =
    capabilitiesRaw ?
      parseCapabilityList(capabilitiesRaw)
    : defaultCapabilitiesForEnvironment(collectorsDir, override, runtimeHints);
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
    agentToken: token.token,
    agentTokenSource: token.source,
    agentTokenFile: token.tokenFile,
    instanceId,
    collectorsDir,
    collectorWorkdir,
    containerRuntime: runtimeHints.containerRuntime,
    containerRuntimeReason: runtimeHints.containerRuntimeReason,
    kubectlBin: runtimeHints.kubectlBin,
    kubeconfigPath: runtimeHints.kubeconfigPath,
    capabilities,
    pollIntervalMs,
    maxBackoffMs,
    jobsWaitSeconds,
    artifactFileOverride: override ? resolve(override) : null,
    agentVersion,
    uploadTransport,
    leaseHeartbeatMs,
  };
}
