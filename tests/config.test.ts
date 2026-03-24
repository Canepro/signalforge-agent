import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const KEYS = [
  "SIGNALFORGE_URL",
  "SIGNALFORGE_BASE_URL",
  "SIGNALFORGE_AGENT_TOKEN",
  "SIGNALFORGE_AGENT_INSTANCE_ID",
  "SIGNALFORGE_COLLECTORS_DIR",
  "SIGNALFORGE_POLL_INTERVAL_MS",
  "SIGNALFORGE_AGENT_ARTIFACT_FILE",
  "SIGNALFORGE_AGENT_VERSION",
  "SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS",
] as const;

function clearEnv(): void {
  for (const k of KEYS) {
    delete process.env[k];
  }
}

beforeEach(() => clearEnv());
afterEach(() => clearEnv());

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
  });

  test("parses optional lease heartbeat interval", () => {
    process.env.SIGNALFORGE_URL = "http://x";
    process.env.SIGNALFORGE_AGENT_TOKEN = "t";
    process.env.SIGNALFORGE_AGENT_INSTANCE_ID = "i";
    process.env.SIGNALFORGE_COLLECTORS_DIR = "/tmp/c";
    process.env.SIGNALFORGE_AGENT_LEASE_HEARTBEAT_MS = "5000";
    expect(loadConfig().leaseHeartbeatMs).toBe(5000);
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
