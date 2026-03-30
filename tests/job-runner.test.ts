import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/api.ts";
import type { AgentConfig } from "../src/config.ts";
import { runSingleCycle } from "../src/job-runner.ts";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const ENV_KEYS = [
  "SIGNALFORGE_URL",
  "SIGNALFORGE_AGENT_TOKEN",
  "SIGNALFORGE_AGENT_INSTANCE_ID",
  "SIGNALFORGE_COLLECTORS_DIR",
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => clearEnv());
afterEach(() => clearEnv());

function testConfig(): AgentConfig {
  return {
    baseUrl: "http://localhost:3000",
    agentToken: "test-token",
    agentTokenSource: "env",
    agentTokenFile: null,
    instanceId: "test-instance",
    collectorsDir: "/tmp/collectors",
    collectorWorkdir: tmpdir(),
    containerRuntime: null,
    containerRuntimeReason: "missing container runtime binary on PATH (docker or podman)",
    kubectlBin: "kubectl",
    kubeconfigPath: null,
    capabilities: [
      "collect:linux-audit-log",
      "collect:container-diagnostics",
      "collect:kubernetes-bundle",
      "upload:multipart",
    ],
    pollIntervalMs: 30_000,
    maxBackoffMs: 300_000,
    jobsWaitSeconds: 20,
    artifactFileOverride: null,
    agentVersion: "0.1.0-test",
    uploadTransport: "fetch",
    leaseHeartbeatMs: 45_000,
  };
}

describe("runSingleCycle", () => {
  test("noop when jobs list empty", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/agent/heartbeat")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        return new Response(JSON.stringify({ jobs: [], gate: null }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };
    const r = await runSingleCycle(testConfig(), fetchImpl);
    expect(r).toEqual({ kind: "noop", reason: "no_job", gate: null });
  });

  test("passes wait_seconds to jobs/next when requested", async () => {
    let seenUrl = "";
    const fetchImpl: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/agent/heartbeat")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        seenUrl = url;
        return new Response(JSON.stringify({ jobs: [], gate: null }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };
    await runSingleCycle(testConfig(), fetchImpl, { waitSeconds: 12 });
    expect(seenUrl).toContain("wait_seconds=12");
  });

  test("returns error 5 on claim 409", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/agent/heartbeat")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
          return new Response(
            JSON.stringify({
            jobs: [
              {
                id: "11111111-1111-1111-1111-111111111111",
                artifact_type: "linux-audit-log",
              },
            ],
            gate: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/claim")) {
        return new Response(JSON.stringify({ code: "not_queued" }), {
          status: 409,
        });
      }
      return new Response("{}", { status: 500 });
    };
    const r = await runSingleCycle(testConfig(), fetchImpl);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.code).toBe(5);
      expect(r.message).toContain("claim");
    }
  });

  test("treats artifact 409 job_already_submitted as processed", async () => {
    const jobId = "22222222-2222-2222-2222-222222222222";
    const fetchImpl: FetchLike = async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/agent/heartbeat")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        return new Response(
          JSON.stringify({
            jobs: [{ id: jobId, artifact_type: "linux-audit-log" }],
            gate: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/claim")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/start")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/artifact")) {
        return new Response(
          JSON.stringify({ code: "job_already_submitted" }),
          { status: 409 }
        );
      }
      if (url.includes("/fail")) {
        return new Response("unexpected fail", { status: 500 });
      }
      return new Response("{}", { status: 404 });
    };

    const fixture = join(import.meta.dir, "fixture-audit.log");
    const cfg = {
      ...testConfig(),
      artifactFileOverride: fixture,
    };

    await Bun.write(
      fixture,
      "=== signalforge-collectors ===\nhostname: t\n=== uname -a ===\nLinux t 1.0 x86_64\n"
    );
    try {
      const r = await runSingleCycle(cfg, fetchImpl);
      expect(r).toEqual({ kind: "processed", jobId });
    } finally {
      try {
        await unlink(fixture);
      } catch {
        /* ignore */
      }
    }
  });

  test("POST fail lease_not_extended when first mid-job heartbeat rejects lease", async () => {
    const jobId = "33333333-3333-3333-3333-333333333333";
    let failBody: string | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/agent/heartbeat") && method === "POST") {
        const raw = init?.body;
        const body =
          typeof raw === "string" ?
            (JSON.parse(raw) as { active_job_id?: string | null })
          : {};
        if (body.active_job_id != null) {
          return new Response(
            JSON.stringify({
              active_job_lease: { extended: false, code: "lease_expired" },
            }),
            { status: 200 }
          );
        }
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        return new Response(
          JSON.stringify({
            jobs: [{ id: jobId, artifact_type: "linux-audit-log" }],
            gate: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/claim")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/start")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/fail") && method === "POST") {
        failBody = typeof init?.body === "string" ? init.body : null;
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const r = await runSingleCycle(testConfig(), fetchImpl);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe(4);
    if (failBody == null) throw new Error("expected POST /fail body");
    const parsed = JSON.parse(failBody) as { code?: string; message?: string };
    expect(parsed.code).toBe("lease_not_extended");
    expect(parsed.message).toContain("lease_expired");
  });

  test("POST fail lease_not_extended when pre-upload heartbeat rejects lease", async () => {
    const jobId = "44444444-4444-4444-4444-444444444444";
    let midCount = 0;
    let failBody: string | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/agent/heartbeat") && method === "POST") {
        const raw = init?.body;
        const body =
          typeof raw === "string" ?
            (JSON.parse(raw) as { active_job_id?: string | null })
          : {};
        if (body.active_job_id != null) {
          midCount += 1;
          if (midCount === 1) {
            return new Response(
              JSON.stringify({ active_job_lease: { extended: true } }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              active_job_lease: { extended: false, code: "stall" },
            }),
            { status: 200 }
          );
        }
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        return new Response(
          JSON.stringify({
            jobs: [{ id: jobId, artifact_type: "linux-audit-log" }],
            gate: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/claim")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/start")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/artifact")) {
        return new Response("should not upload", { status: 500 });
      }
      if (url.includes("/fail") && method === "POST") {
        failBody = typeof init?.body === "string" ? init.body : null;
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const fixture = join(import.meta.dir, "lease-preupload.log");
    const cfg = {
      ...testConfig(),
      artifactFileOverride: fixture,
      leaseHeartbeatMs: 60_000,
    };
    await Bun.write(fixture, "artifact bytes\n");
    try {
      const r = await runSingleCycle(cfg, fetchImpl);
      expect(r.kind).toBe("error");
      if (r.kind === "error") expect(r.code).toBe(4);
      expect(midCount).toBe(2);
      if (failBody == null) throw new Error("expected POST /fail body");
      const parsed = JSON.parse(failBody) as { code?: string; message?: string };
      expect(parsed.code).toBe("lease_not_extended");
      expect(parsed.message).toContain("stall");
    } finally {
      try {
        await unlink(fixture);
      } catch {
        /* ignore */
      }
    }
  });

  test("dispatches collection by artifact type and uploads artifact_type", async () => {
    const jobId = "55555555-5555-5555-5555-555555555555";
    const collectorsDir = await mkdtemp(join(tmpdir(), "sf-agent-collectors-"));
    const collectorWorkdir = await mkdtemp(join(tmpdir(), "sf-agent-container-workdir-"));
    const scriptPath = join(collectorsDir, "collect-container-diagnostics.sh");
    const producedPath = join(
      collectorWorkdir,
      "container_diagnostics_payments-api_20260326_101500.txt"
    );
    await writeFile(
      scriptPath,
      `#!/usr/bin/env bash
cat > "${producedPath}" <<'EOF'
=== container-diagnostics ===
container_name: demo
runtime: docker
EOF
`,
      "utf8"
    );

    let seenArtifactType: string | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/agent/heartbeat") && method === "POST") {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        return new Response(
          JSON.stringify({
            jobs: [{ id: jobId, artifact_type: "container-diagnostics" }],
            gate: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/claim")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/start")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/artifact")) {
        const form = init?.body as
          | { get(name: string): FormDataEntryValue | null }
          | undefined;
        seenArtifactType = form?.get("artifact_type")?.toString() ?? null;
        if (form == null) {
          return new Response(JSON.stringify({ run_id: "run-1", artifact_id: "art-1" }), {
            status: 200,
          });
        }
        const file = form.get("file");
        if (!(file instanceof File)) {
          return new Response(JSON.stringify({ run_id: "run-1", artifact_id: "art-1" }), {
            status: 200,
          });
        }
        if (file.name !== "container_diagnostics_payments-api_20260326_101500.txt") {
          return new Response(
            JSON.stringify({ run_id: "run-1", artifact_id: "art-1" }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ run_id: "run-1", artifact_id: "art-1" }), {
          status: 200,
        });
      }
      if (url.includes("/fail")) {
        return new Response("unexpected fail", { status: 500 });
      }
      return new Response("{}", { status: 404 });
    };

    const cfg = {
      ...testConfig(),
      collectorsDir,
      collectorWorkdir,
    };

    try {
      const r = await runSingleCycle(cfg, fetchImpl);
      expect(r).toEqual({ kind: "processed", jobId });
      if (seenArtifactType == null || seenArtifactType !== "container-diagnostics") {
        throw new Error(`expected artifact_type container-diagnostics, got ${seenArtifactType}`);
      }
    } finally {
      await unlink(scriptPath).catch(() => undefined);
      await unlink(producedPath).catch(() => undefined);
      await rm(collectorsDir, { recursive: true, force: true });
      await rm(collectorWorkdir, { recursive: true, force: true });
    }
  });

  test("passes jobs/next collection_scope through to collector invocation", async () => {
    const jobId = "66666666-6666-6666-6666-666666666666";
    const collectorsDir = await mkdtemp(join(tmpdir(), "sf-agent-k8s-collectors-"));
    const collectorWorkdir = await mkdtemp(join(tmpdir(), "sf-agent-k8s-workdir-"));
    const scriptPath = join(collectorsDir, "collect-kubernetes-bundle.sh");
    const producedPath = join(
      collectorWorkdir,
      "kubernetes_bundle_payments_20260326_101500.json"
    );
    const argsPath = join(collectorsDir, "collector-args.txt");
    await writeFile(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "${argsPath}"
printf '{}\n' > "${producedPath}"
`,
      "utf8"
    );

    const fetchImpl: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/agent/heartbeat") && method === "POST") {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/agent/jobs/next")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: jobId,
                artifact_type: "kubernetes-bundle",
                collection_scope: {
                  kind: "kubernetes_scope",
                  scope_level: "namespace",
                  namespace: "payments",
                  kubectl_context: "prod-eu-1",
                  cluster_name: "aks-prod-eu-1",
                  provider: "aks",
                },
              },
            ],
            gate: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/claim")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/start")) {
        return new Response(JSON.stringify({ id: jobId }), { status: 200 });
      }
      if (url.includes("/artifact")) {
        return new Response(JSON.stringify({ run_id: "run-2", artifact_id: "art-2" }), {
          status: 200,
        });
      }
      if (url.includes("/fail")) {
        return new Response("unexpected fail", { status: 500 });
      }
      return new Response("{}", { status: 404 });
    };

    const cfg = {
      ...testConfig(),
      collectorsDir,
      collectorWorkdir,
    };
    const seenLogs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      seenLogs.push(args.map((part) => String(part)).join(" "));
    };

    try {
      const r = await runSingleCycle(cfg, fetchImpl);
      expect(r).toEqual({ kind: "processed", jobId });
      const args = await Bun.file(argsPath).text();
      expect(args).toContain(
        "--scope namespace --namespace payments --context prod-eu-1 --cluster-name aks-prod-eu-1 --provider aks"
      );
      expect(
        seenLogs.some((line) =>
          line.includes(
            "claimed job 66666666-6666-6666-6666-666666666666 artifact_type=kubernetes-bundle scope=kubernetes_scope(scope_level=namespace,namespace=payments,kubectl_context=prod-eu-1,cluster_name=aks-prod-eu-1,provider=aks)"
          )
        )
      ).toBe(true);
    } finally {
      console.error = originalConsoleError;
      await unlink(scriptPath).catch(() => undefined);
      await unlink(producedPath).catch(() => undefined);
      await unlink(argsPath).catch(() => undefined);
      await rm(collectorsDir, { recursive: true, force: true });
      await rm(collectorWorkdir, { recursive: true, force: true });
    }
  });
});
