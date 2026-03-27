import { describe, expect, test } from "bun:test";
import { summarizeCollectionScope } from "../src/collection-scope.ts";

describe("summarizeCollectionScope", () => {
  test("keeps the scope summary as a single log token", () => {
    expect(
      summarizeCollectionScope({
        kind: "container_target",
        container_ref: "payments api\nblue",
        runtime: "podman",
        host_hint: "host a",
      })
    ).toBe(
      "container_target(container_ref=payments%20api%0Ablue,runtime=podman,host_hint=host%20a)"
    );
  });

  test("keeps kubernetes summaries whitespace-free and escaped", () => {
    expect(
      summarizeCollectionScope({
        kind: "kubernetes_scope",
        scope_level: "namespace",
        namespace: "payments prod",
        kubectl_context: "prod-eu-1",
        cluster_name: "aks(prod)",
        provider: "aks",
      })
    ).toBe(
      "kubernetes_scope(scope_level=namespace,namespace=payments%20prod,kubectl_context=prod-eu-1,cluster_name=aks%28prod%29,provider=aks)"
    );
  });
});
