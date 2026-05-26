import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FetchLike } from "../src/api.ts";
import { EnrollError, enrollCollectionAgent } from "../src/enroll.ts";

describe("enrollCollectionAgent", () => {
  test("registers via discovery register_uri and writes token file", async () => {
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth.md")) {
        return new Response("# auth.md", { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource_name: "SignalForge" }), {
          status: 200,
        });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            agent_auth: { register_uri: "http://localhost:3000/agent/auth" },
          }),
          { status: 200 }
        );
      }
      if (url === "http://localhost:3000/agent/auth" && init?.method === "POST") {
        expect(init.headers).toMatchObject({
          authorization: "Bearer admin-test",
        });
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.source_id).toBe("source-1");
        return new Response(
          JSON.stringify({
            agent_id: "agent-1",
            source_id: "source-1",
            token: "plain-token-value",
            token_prefix: "plain-to",
            scopes: ["collection_job.execute"],
          }),
          { status: 201 }
        );
      }
      return new Response("missing", { status: 404 });
    };

    const dir = await mkdtemp(join(tmpdir(), "sf-agent-enroll-"));
    const tokenFile = join(dir, "token");
    try {
      const result = await enrollCollectionAgent({
        baseUrl: "http://localhost:3000",
        sourceId: "source-1",
        adminToken: "admin-test",
        tokenFile,
        fetchImpl,
      });
      expect(result.agentId).toBe("agent-1");
      expect(result.tokenPrefix).toBe("plain-to");
      expect(await readFile(tokenFile, "utf8")).toBe("plain-token-value\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("409 source_already_registered becomes EnrollError", async () => {
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth.md")) return new Response("# auth.md", { status: 200 });
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response("{}", { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({ agent_auth: { register_uri: "http://localhost:3000/agent/auth" } }),
          { status: 200 }
        );
      }
      if (url.endsWith("/agent/auth") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: "already registered",
            code: "source_already_registered",
          }),
          { status: 409 }
        );
      }
      return new Response("missing", { status: 404 });
    };

    await expect(
      enrollCollectionAgent({
        baseUrl: "http://localhost:3000",
        sourceId: "source-1",
        adminToken: "admin-test",
        fetchImpl,
      })
    ).rejects.toMatchObject({
      name: "EnrollError",
      code: "source_already_registered",
      httpStatus: 409,
    } satisfies Partial<EnrollError>);
  });
});
