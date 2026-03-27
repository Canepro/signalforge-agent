import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ConfigError,
  loadConfig,
  runtimeCapabilityChecksForEnvironment,
} from "../src/config.ts";

const KEYS = [
  "SIGNALFORGE_URL",
  "SIGNALFORGE_BASE_URL",
  "SIGNALFORGE_AGENT_TOKEN",
  "SIGNALFORGE_AGENT_TOKEN_FILE",
  "SIGNALFORGE_AGENT_INSTANCE_ID",
  "SIGNALFORGE_COLLECTORS_DIR",
  "SIGNALFORGE_POLL_INTERVAL_MS",
  "SIGNALFORGE_MAX_BACKOFF_MS",
  "SIGNALFORGE_JOBS_WAIT_SECONDS",
  "SIGNALFORGE_AGENT_ARTIFACT_FILE",
  "SIGNALFORGE_AGENT_VERSION",
  "SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS",
  "SIGNALFORGE_AGENT_CAPABILITIES",
  "SIGNALFORGE_KUBECTL_BIN",
  "SIGNALFORGE_KUBECONFIG",
  "KUBECONFIG",
] as const;

const ORIGINAL_PATH = process.env.PATH ?? "";
let tmpDirs: string[] = [];

function clearEnv(): void {
  for (const k of KEYS) {
    delete process.env[k];
  }
  process.env.PATH = ORIGINAL_PATH;
}

beforeEach(() => clearEnv());
afterEach(async () => {
  clearEnv();
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function writeExecutable(path: string, content = "#!/usr/bin/env bash\nexit 0\n"): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

describe("loadConfig", () => {
  test("requires base URL", () => {
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("requires collectors dir unless artifact override", () => {
    process.env.SIGNALFORGE_URL = "http://localhost:3000";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("allows artifact override without collectors dir", () => {
    process.env.SIGNALFORGE_URL = "http://localhost:3000/";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_AGENT_ARTIFACT_FILE = "/tmp/x.log";
    const c = loadConfig();
    expect(c.baseUrl).toBe("http://localhost:3000");
    expect(c.artifactFileOverride).toContain("x.log");
    expect(c.leaseHeartbeatMs).toBe(45_000);
    expect(c.maxBackoffMs).toBe(300_000);
    expect(c.capabilities).toEqual(["upload:multipart"]);
  });

  test("loads token from SIGNALFORGE_AGENT_TOKEN_FILE", async () => {
    const tokenFile = join(await makeTempDir("sf-agent-token-"), "token");
    await writeFile(tokenFile, "token-from-file\n", "utf8");
    process.env.SIGNALFORGE_URL = "http://localhost:3000";
    process.env.SIGNALFORGE_AGENT_TOKEN_FILE = tokenFile;
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_AGENT_ARTIFACT_FILE = "/tmp/x.log";
    const c = loadConfig();
    expect(c.agentToken).toBe("token-from-file");
    expect(c.agentTokenSource).toBe("file");
    expect(c.agentTokenFile).toContain("token");
  });

  test("loads explicit kubeconfig path and exports it to KUBECONFIG", async () => {
    const kubeconfigPath = join(await makeTempDir("sf-agent-kubeconfig-"), "config");
    await writeFile(kubeconfigPath, "apiVersion: v1\nkind: Config\n", "utf8");
    process.env.SIGNALFORGE_URL = "http://localhost:3000";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_AGENT_ARTIFACT_FILE = "/tmp/x.log";
    process.env.SIGNALFORGE_KUBECONFIG = kubeconfigPath;

    const c = loadConfig();
    expect(c.kubeconfigPath).toBe(kubeconfigPath);
    expect(process.env.KUBECONFIG).toBe(kubeconfigPath);
  });

  test("rejects missing explicit kubeconfig path", () => {
    process.env.SIGNALFORGE_URL = "http://localhost:3000";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_AGENT_ARTIFACT_FILE = "/tmp/x.log";
    process.env.SIGNALFORGE_KUBECONFIG = "/tmp/does-not-exist-kubeconfig";

    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("parses optional capability set", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_AGENT_CAPABILITIES =
      "collect:linux-audit-log, collect:kubernetes-bundle, upload:multipart";
    expect(loadConfig().capabilities).toEqual([
      "collect:linux-audit-log",
      "collect:kubernetes-bundle",
      "upload:multipart",
    ]);
  });

  test("derives capabilities from locally runnable collectors", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    const binDir = await makeTempDir("sf-agent-bin-");
    await writeExecutable(join(collectorsDir, "first-audit.sh"));
    await writeExecutable(join(collectorsDir, "collect-container-diagnostics.sh"));
    await writeExecutable(join(collectorsDir, "collect-kubernetes-bundle.sh"));
    await writeExecutable(join(binDir, "podman"));
    await writeExecutable(join(binDir, "kubectl"));

    process.env.PATH = binDir;
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = collectorsDir;

    const config = loadConfig();
    expect(config.capabilities).toEqual([
      "collect:linux-audit-log",
      "collect:container-diagnostics",
      "collect:kubernetes-bundle",
      "upload:multipart",
    ]);
    expect(config.containerRuntime).toBe("podman");
    expect(config.containerRuntimeReason).toBe("podman runtime accessible");
  });

  test("does not advertise container collection without a runtime binary", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    const binDir = await makeTempDir("sf-agent-bin-");
    await writeExecutable(join(collectorsDir, "first-audit.sh"));
    await writeExecutable(join(collectorsDir, "collect-container-diagnostics.sh"));
    await writeExecutable(join(collectorsDir, "collect-kubernetes-bundle.sh"));
    await writeExecutable(join(binDir, "kubectl"));

    process.env.PATH = binDir;
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = collectorsDir;

    expect(loadConfig().capabilities).toEqual([
      "collect:linux-audit-log",
      "collect:kubernetes-bundle",
      "upload:multipart",
    ]);
  });

  test("does not advertise container collection when runtime access fails", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    const binDir = await makeTempDir("sf-agent-bin-");
    await writeExecutable(join(collectorsDir, "first-audit.sh"));
    await writeExecutable(join(collectorsDir, "collect-container-diagnostics.sh"));
    const dockerPath = join(binDir, "docker");
    await writeFile(
      dockerPath,
      "#!/bin/sh\necho 'permission denied while trying to connect to the Docker daemon socket' >&2\nexit 1\n",
      "utf8"
    );
    await chmod(dockerPath, 0o755);

    process.env.PATH = binDir;
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = collectorsDir;

    const config = loadConfig();
    expect(config.capabilities).toEqual([
      "collect:linux-audit-log",
      "upload:multipart",
    ]);
    expect(config.containerRuntime).toBeNull();
    expect(config.containerRuntimeReason).toContain("permission denied");
  });

  test("parses optional lease heartbeat interval", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS = "5000";
    expect(loadConfig().leaseHeartbeatMs).toBe(5000);
  });

  test("parses optional jobs wait seconds", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_JOBS_WAIT_SECONDS = "7";
    expect(loadConfig().jobsWaitSeconds).toBe(7);
  });

  test("rejects jobs wait seconds over 20", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_JOBS_WAIT_SECONDS = "21";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects lease heartbeat under 1000", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS = "500";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects poll interval under 1000", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_POLL_INTERVAL_MS = "500";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("parses optional max backoff", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_MAX_BACKOFF_MS = "120000";
    expect(loadConfig().maxBackoffMs).toBe(120_000);
  });

  test("rejects max backoff under poll interval", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_POLL_INTERVAL_MS = "30000";
    process.env.SIGNALFORGE_MAX_BACKOFF_MS = "20000";
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe("runtimeCapabilityChecksForEnvironment", () => {
  test("reports readiness reasons for missing runtimes", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    await writeExecutable(join(collectorsDir, "first-audit.sh"));
    await writeExecutable(join(collectorsDir, "collect-container-diagnostics.sh"));
    await writeExecutable(join(collectorsDir, "collect-kubernetes-bundle.sh"));

    process.env.PATH = "";
    process.env.SIGNALFORGE_KUBECTL_BIN = "kubectl";

    expect(
      runtimeCapabilityChecksForEnvironment(collectorsDir, null, {
        kubectlBin: "kubectl",
        kubeconfigPath: null,
        containerRuntime: null,
        containerRuntimeReason: "missing container runtime binary on PATH (docker or podman)",
      })
    ).toEqual([
      {
        capability: "collect:linux-audit-log",
        enabled: true,
        reason: "first-audit.sh found",
      },
      {
        capability: "collect:container-diagnostics",
        enabled: false,
        reason: "missing container runtime binary on PATH (docker or podman)",
      },
      {
        capability: "collect:kubernetes-bundle",
        enabled: false,
        reason: "missing kubectl binary on PATH (kubectl)",
      },
    ]);
  });

  test("reports explicit kubeconfig in kubernetes readiness reason", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    const binDir = await makeTempDir("sf-agent-bin-");
    const kubeconfigPath = join(await makeTempDir("sf-agent-kubeconfig-"), "config");
    await writeExecutable(join(collectorsDir, "collect-kubernetes-bundle.sh"));
    await writeExecutable(join(binDir, "kubectl"));
    await writeFile(kubeconfigPath, "apiVersion: v1\nkind: Config\n", "utf8");

    process.env.PATH = binDir;

    expect(
      runtimeCapabilityChecksForEnvironment(collectorsDir, null, {
        kubectlBin: "kubectl",
        kubeconfigPath,
        containerRuntime: null,
        containerRuntimeReason: "missing container runtime binary on PATH (docker or podman)",
      })
    ).toEqual([
      {
        capability: "collect:linux-audit-log",
        enabled: false,
        reason: "missing first-audit.sh in collectors dir",
      },
      {
        capability: "collect:container-diagnostics",
        enabled: false,
        reason: "missing collect-container-diagnostics.sh in collectors dir",
      },
      {
        capability: "collect:kubernetes-bundle",
        enabled: true,
        reason: `kubectl binary found (kubectl); kubeconfig set (${kubeconfigPath})`,
      },
    ]);
  });

  test("reports inaccessible docker daemon in container readiness reason", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    await writeExecutable(join(collectorsDir, "collect-container-diagnostics.sh"));

    expect(
      runtimeCapabilityChecksForEnvironment(collectorsDir, null, {
        kubectlBin: "kubectl",
        kubeconfigPath: null,
        containerRuntime: null,
        containerRuntimeReason:
          "docker found but not usable: permission denied while trying to connect to the Docker daemon socket",
      })
    ).toEqual([
      {
        capability: "collect:linux-audit-log",
        enabled: false,
        reason: "missing first-audit.sh in collectors dir",
      },
      {
        capability: "collect:container-diagnostics",
        enabled: false,
        reason:
          "docker found but not usable: permission denied while trying to connect to the Docker daemon socket",
      },
      {
        capability: "collect:kubernetes-bundle",
        enabled: false,
        reason: "missing collect-kubernetes-bundle.sh in collectors dir",
      },
    ]);
  });
});
