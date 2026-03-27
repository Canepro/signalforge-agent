import type { AgentConfig } from "./config.ts";
import {
  ConfigError,
  loadConfig,
  runtimeCapabilityChecksForEnvironment,
} from "./config.ts";

export function buildPreflightLines(cfg: AgentConfig): string[] {
  const lines: string[] = [];
  lines.push(`Base URL: ${cfg.baseUrl}`);
  lines.push(`Instance ID: ${cfg.instanceId}`);
  lines.push(
    `Token source: ${cfg.agentTokenSource}${cfg.agentTokenFile ? ` (${cfg.agentTokenFile})` : ""}`
  );
  lines.push(
    cfg.artifactFileOverride ?
      `Artifact override: ${cfg.artifactFileOverride}`
    : `Collectors dir: ${cfg.collectorsDir}`
  );
  lines.push(`Backoff: base ${cfg.pollIntervalMs}ms, max ${cfg.maxBackoffMs}ms`);
  lines.push(`Effective capabilities: ${cfg.capabilities.join(", ")}`);

  for (const check of runtimeCapabilityChecksForEnvironment(
    cfg.collectorsDir,
    cfg.artifactFileOverride
  )) {
    lines.push(
      `- ${check.capability}: ${check.enabled ? "ready" : "not ready"} (${check.reason})`
    );
  }

  return lines;
}

export function runPreflight(args: string[] = []): number {
  const quiet = args.includes("--quiet");
  try {
    const cfg = loadConfig();
    if (!quiet) {
      console.log("SignalForge agent preflight");
      for (const line of buildPreflightLines(cfg)) {
        console.log(line);
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    if (!quiet) {
      console.error(`Preflight failed: ${message}`);
    }
    return 6;
  }
}
