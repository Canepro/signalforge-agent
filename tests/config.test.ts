import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const KEYS = [
  "SIGNALFORGE_URL",
  "SIGNALFORGE_BASE_URL",
  "SIGNALFORGE_AGENT_TOKEN",
  "SIGNALFORGE_AGENT_INSTANCE_ID",
  "SIGNALFORGE_COLLECTORS_DIR",
  "SIGNALFORGE_POLL_INTERVAL_MS",
  "SIGNALFORGE_JOBS_WAIT_SECONDS",
  "SIGNALFORGE_AGENT_ARTIFACT_FILE",
  "SIGNALFORGE_AGENT_VERSION",
  "SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS",
  "SIGNALFORGE_AGENT_CAPABILITIES",
  "SIGNALFORGE_CONTAINER_REF",
  "SIGNALFORGE_KUBECTL_BIN",
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
    expect(c.capabilities).toEqual(["upload:multipart"]);
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

    process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = collectorsDir;
    process.env.SIGNALFORGE_CONTAINER_REF = "payments-api";

    expect(loadConfig().capabilities).toEqual([
      "collect:linux-audit-log",
      "collect:container-diagnostics",
      "collect:kubernetes-bundle",
      "upload:multipart",
    ]);
  });

  test("does not advertise container collection without a target container ref", async () => {
    const collectorsDir = await makeTempDir("sf-agent-collectors-");
    const binDir = await makeTempDir("sf-agent-bin-");
    await writeExecutable(join(collectorsDir, "first-audit.sh"));
    await writeExecutable(join(collectorsDir, "collect-container-diagnostics.sh"));
    await writeExecutable(join(collectorsDir, "collect-kubernetes-bundle.sh"));
    await writeExecutable(join(binDir, "podman"));
    await writeExecutable(join(binDir, "kubectl"));

    process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;
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
});
