import { describe, expect, test } from "bun:test";
import { fetchDiscoverySnapshot, formatDiscoverySummary } from "../src/discovery.ts";
import type { FetchLike } from "../src/api.ts";

describe("fetchDiscoverySnapshot", () => {
  test("loads auth.md and well-known metadata", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/auth.md")) {
        return new Response("# auth.md\nRegister here.", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      }
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource_name: "SignalForge",
            scopes_supported: ["collection_job.execute"],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            agent_auth: {
              register_uri: "http://localhost:3000/agent/auth",
              compatibility: {
                legacy_register_uri: "http://localhost:3000/api/agent/registrations",
                claim_implemented: false,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    };

    const snapshot = await fetchDiscoverySnapshot("http://localhost:3000/", fetchImpl);
    expect(snapshot.registerUri).toBe("http://localhost:3000/agent/auth");
    expect(snapshot.legacyRegisterUri).toBe("http://localhost:3000/api/agent/registrations");
    expect(snapshot.claimImplemented).toBe(false);
    expect(formatDiscoverySummary(snapshot)).toContain("register_uri=http://localhost:3000/agent/auth");
  });
});
