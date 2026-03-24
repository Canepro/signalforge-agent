import { describe, expect, test } from "bun:test";
import { AuthError, createClient } from "../src/api.ts";

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
});
