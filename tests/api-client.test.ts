import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  ApiError,
  AuthError,
  createClient,
  isRetryableApiFailure,
  type FetchLike,
} from "../src/api.ts";

describe("SignalForgeAgentClient", () => {
  test("401 becomes AuthError with body text", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ code: "invalid_token", error: "nope" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const client = createClient("http://localhost:3000", "bad", fetchImpl);
    let err: unknown;
    try {
      await client.heartbeat({
        capabilities: ["collect:linux-audit-log"],
        attributes: {},
        agent_version: "0",
        active_job_id: null,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
    expect((err as AuthError).bodyText).toContain("invalid_token");
  });

  test("non-401 error includes server code in message", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ code: "lease_expired" }), {
        status: 409,
      });
    const client = createClient("http://localhost:3000", "tok", fetchImpl);
    await expect(
      client.claim("job-1", "inst", 60)
    ).rejects.toThrow(/lease_expired/);
  });

  test("artifact upload includes artifact_type", async () => {
    let seenArtifactType = "";
    let seenInstanceId = "";
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = init?.body as
        | { get(name: string): FormDataEntryValue | null }
        | undefined;
      if (body != null) {
        seenArtifactType = body.get("artifact_type")?.toString() ?? "";
        seenInstanceId = body.get("instance_id")?.toString() ?? "";
      }
      return new Response(JSON.stringify({ run_id: "run-1" }), {
        status: 200,
      });
    };

    const client = createClient("http://localhost:3000", "tok", fetchImpl);
    const filePath = `${import.meta.dir}/fixture-upload.log`;
    await Bun.write(filePath, "payload\n");
    try {
      await client.uploadArtifact(
        "job-1",
        "inst-1",
        "container-diagnostics",
        filePath,
        "fixture-upload.log"
      );
    } finally {
      try {
        await unlink(filePath);
      } catch {
        /* ignore */
      }
    }

    if (!seenArtifactType || !seenInstanceId) {
      throw new Error("expected multipart form body");
    }
    expect(seenArtifactType).toBe("container-diagnostics");
    expect(seenInstanceId).toBe("inst-1");
  });

  test("curl upload transport sends artifact metadata and parses JSON response", async () => {
    let seenRequest:
      | {
          url: string;
          token: string;
          filePath: string;
          filename: string;
          instanceId: string;
          artifactType: string;
        }
      | undefined;

    const client = createClient(
      "http://localhost:3000",
      "tok",
      async () => new Response("unexpected fetch path", { status: 500 }),
      {
        uploadTransport: "curl",
        curlRunner: async (request) => {
          seenRequest = request;
          return {
            status: 200,
            bodyText: JSON.stringify({ run_id: "run-2", artifact_id: "art-2" }),
          };
        },
      }
    );

    const response = await client.uploadArtifact(
      "job-2",
      "inst-2",
      "kubernetes-bundle",
      "/tmp/fake-bundle.json",
      "bundle.json"
    );

    expect(response.run_id).toBe("run-2");
    expect(seenRequest).toEqual({
      url: "http://localhost:3000/api/collection-jobs/job-2/artifact",
      token: "tok",
      filePath: "/tmp/fake-bundle.json",
      filename: "bundle.json",
      instanceId: "inst-2",
      artifactType: "kubernetes-bundle",
    });
  });

  test("jobsNext rejects malformed job rows", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          jobs: [{ id: "job-1" }],
          gate: null,
        }),
        { status: 200 }
      );
    const client = createClient("http://localhost:3000", "tok", fetchImpl);
    await expect(client.jobsNext(1)).rejects.toThrow(/malformed job entry/);
  });

  test("fixActionsNext parses deterministic action payloads", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          actions: [
            {
              id: "action-1",
              policy_id: "kubernetes.disable-service-account-token-automount.v1",
              action_kind: "kubernetes_patch",
              action_payload: {
                kind: "kubernetes_safe_patch",
                policy_id: "kubernetes.disable-service-account-token-automount.v1",
                action_kind: "kubernetes_patch",
                target: {
                  api_version: "apps/v1",
                  kind: "Deployment",
                  namespace: "payments",
                  name: "payments-api",
                  resource: "deployment/payments-api",
                },
                patch_template: {
                  kind: "kubernetes_patch_template",
                  patch_type: "server_side_apply",
                  manifest: {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    metadata: { name: "payments-api", namespace: "payments" },
                    spec: { template: { spec: { automountServiceAccountToken: false } } },
                  },
                },
                changed_fields: ["spec.template.spec.automountServiceAccountToken"],
              },
            },
          ],
          gate: null,
        }),
        { status: 200 }
      );
    const client = createClient("http://localhost:3000", "tok", fetchImpl);
    const result = await client.fixActionsNext(1);
    expect(result.actions[0].action_payload.target.resource).toBe("deployment/payments-api");
  });

  test("retryable API failures exclude arbitrary local errors", () => {
    expect(
      isRetryableApiFailure(
        new ApiError("GET", "/api/agent/jobs/next", 503, "unavailable", null)
      )
    ).toBe(true);
    expect(isRetryableApiFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableApiFailure(new Error("programmer bug"))).toBe(false);
  });
});
