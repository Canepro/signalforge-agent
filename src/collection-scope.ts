export type ContainerRuntime = "docker" | "podman";

export type LinuxHostCollectionScope = { kind: "linux_host" };

export type ContainerTargetCollectionScope = {
  kind: "container_target";
  runtime?: ContainerRuntime;
  container_ref: string;
  host_hint?: string;
};

export type KubernetesScopeCollectionScope = {
  kind: "kubernetes_scope";
  scope_level: "cluster" | "namespace";
  namespace?: string;
  kubectl_context?: string;
  cluster_name?: string;
  provider?: string;
};

export type CollectionScope =
  | LinuxHostCollectionScope
  | ContainerTargetCollectionScope
  | KubernetesScopeCollectionScope;

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export function parseCollectionScope(value: unknown): CollectionScope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (record.kind === "linux_host") {
    return hasOnlyKeys(record, ["kind"]) ? { kind: "linux_host" } : null;
  }

  if (record.kind === "container_target") {
    if (!hasOnlyKeys(record, ["kind", "runtime", "container_ref", "host_hint"])) return null;
    if (typeof record.container_ref !== "string" || !record.container_ref.trim()) return null;
    if (
      record.runtime !== undefined &&
      record.runtime !== "docker" &&
      record.runtime !== "podman"
    ) {
      return null;
    }
    if (record.host_hint !== undefined && typeof record.host_hint !== "string") return null;
    return {
      kind: "container_target",
      container_ref: record.container_ref,
      runtime: record.runtime as ContainerRuntime | undefined,
      host_hint: record.host_hint as string | undefined,
    };
  }

  if (record.kind === "kubernetes_scope") {
    if (
      !hasOnlyKeys(record, [
        "kind",
        "scope_level",
        "namespace",
        "kubectl_context",
        "cluster_name",
        "provider",
      ])
    ) {
      return null;
    }
    if (record.scope_level !== "cluster" && record.scope_level !== "namespace") return null;
    if (record.namespace !== undefined) {
      if (typeof record.namespace !== "string" || !record.namespace.trim()) return null;
    }
    if (record.scope_level === "namespace" && !record.namespace) return null;
    if (
      (record.kubectl_context !== undefined && typeof record.kubectl_context !== "string") ||
      (record.cluster_name !== undefined && typeof record.cluster_name !== "string") ||
      (record.provider !== undefined && typeof record.provider !== "string")
    ) {
      return null;
    }
    return {
      kind: "kubernetes_scope",
      scope_level: record.scope_level,
      namespace: record.namespace as string | undefined,
      kubectl_context: record.kubectl_context as string | undefined,
      cluster_name: record.cluster_name as string | undefined,
      provider: record.provider as string | undefined,
    };
  }

  return null;
}
