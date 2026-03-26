import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  collectorSpecForArtifact,
  pickProducedMatchingFile,
  pickProducedAuditLog,
  snapshotMatchingFiles,
  snapshotAuditLogs,
} from "../src/collector.ts";

describe("pickProducedAuditLog", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("returns null when no new or updated log", async () => {
    dir = await mkdtemp(join(tmpdir(), "sf-agent-col-"));
    const stale = join(dir, "server_audit_20200101_120000.log");
    await writeFile(stale, "old\n", "utf8");
    const before = await snapshotAuditLogs(dir);
    expect(await pickProducedAuditLog(dir, before)).toBeNull();
  });

  test("prefers a newly created log file", async () => {
    dir = await mkdtemp(join(tmpdir(), "sf-agent-col-"));
    const stale = join(dir, "server_audit_20200101_120000.log");
    await writeFile(stale, "old\n", "utf8");
    const before = await snapshotAuditLogs(dir);
    const fresh = join(dir, "server_audit_20990101_120000.log");
    await writeFile(fresh, "new\n", "utf8");
    const picked = await pickProducedAuditLog(dir, before);
    expect(picked).toBe(fresh);
  });

  test("accepts an in-place mtime update of an existing log", async () => {
    dir = await mkdtemp(join(tmpdir(), "sf-agent-col-"));
    const name = "server_audit_20200202_120000.log";
    const path = join(dir, name);
    await writeFile(path, "v1\n", "utf8");
    const before = await snapshotAuditLogs(dir);
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(path, "v2\n", "utf8");
    const picked = await pickProducedAuditLog(dir, before);
    expect(picked).toBe(path);
  });
});

describe("artifact-family matching", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("accepts collector-style container artifact names with target suffixes", async () => {
    dir = await mkdtemp(join(tmpdir(), "sf-agent-col-"));
    const { producedFileRe } = collectorSpecForArtifact("container-diagnostics");
    const before = await snapshotMatchingFiles(dir, producedFileRe);
    const fresh = join(dir, "container_diagnostics_payments-api_20990101_120000.txt");
    await writeFile(fresh, "container\n", "utf8");
    const picked = await pickProducedMatchingFile(dir, before, producedFileRe);
    expect(picked).toBe(fresh);
  });

  test("accepts collector-style kubernetes bundle names with scope suffixes", async () => {
    dir = await mkdtemp(join(tmpdir(), "sf-agent-col-"));
    const { producedFileRe } = collectorSpecForArtifact("kubernetes-bundle");
    const before = await snapshotMatchingFiles(dir, producedFileRe);
    const fresh = join(dir, "kubernetes_bundle_payments_20990101_120000.json");
    await writeFile(fresh, "{}\n", "utf8");
    const picked = await pickProducedMatchingFile(dir, before, producedFileRe);
    expect(picked).toBe(fresh);
  });
});
