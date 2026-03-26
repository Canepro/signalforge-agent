import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CollectionScope } from "./collection-scope.ts";

export class CollectorError extends Error {
  override readonly name = "CollectorError";
}

export type ArtifactType =
  | "linux-audit-log"
  | "container-diagnostics"
  | "kubernetes-bundle";

type CollectorSpec = {
  script: string;
  producedFileRe: RegExp;
  artifactType: ArtifactType;
};

const COLLECTOR_SPECS: Record<ArtifactType, CollectorSpec> = {
  "linux-audit-log": {
    script: "first-audit.sh",
    producedFileRe: /^server_audit_\d{8}_\d{6}\.log$/,
    artifactType: "linux-audit-log",
  },
  "container-diagnostics": {
    script: "collect-container-diagnostics.sh",
    producedFileRe:
      /^container[-_]diagnostics(?:_[a-z0-9._-]+)?_\d{8}_\d{6}\.(?:txt|log|json)$/,
    artifactType: "container-diagnostics",
  },
  "kubernetes-bundle": {
    script: "collect-kubernetes-bundle.sh",
    producedFileRe:
      /^kubernetes[-_]bundle(?:_[a-z0-9._-]+)?_\d{8}_\d{6}\.json$/,
    artifactType: "kubernetes-bundle",
  },
};

export function isArtifactType(value: string): value is ArtifactType {
  return value in COLLECTOR_SPECS;
}

/**
 * Basename → mtimeMs for existing audit logs before a collector run.
 */
export async function snapshotMatchingFiles(
  dir: string,
  fileRe: RegExp
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!fileRe.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (st.isFile()) map.set(name, st.mtimeMs);
    } catch {
      /* skip */
    }
  }
  return map;
}

export async function snapshotAuditLogs(dir: string): Promise<Map<string, number>> {
  return snapshotMatchingFiles(dir, COLLECTOR_SPECS["linux-audit-log"].producedFileRe);
}

/**
 * After a collector run: newest matching log that is new or has a strictly newer mtime than before.
 */
export async function pickProducedMatchingFile(
  dir: string,
  before: Map<string, number>,
  fileRe: RegExp
): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!fileRe.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const prev = before.get(name);
      const produced = prev === undefined || st.mtimeMs > prev;
      if (!produced) continue;
      if (!best || st.mtimeMs > best.mtime) {
        best = { path, mtime: st.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }
  return best?.path ?? null;
}

export async function pickProducedAuditLog(
  dir: string,
  before: Map<string, number>
): Promise<string | null> {
  return pickProducedMatchingFile(
    dir,
    before,
    COLLECTOR_SPECS["linux-audit-log"].producedFileRe
  );
}

function collectorSpecForArtifactType(artifactType: ArtifactType): CollectorSpec {
  return COLLECTOR_SPECS[artifactType];
}

async function runCollectorScript(
  collectorsDir: string,
  artifactType: ArtifactType,
  collectionScope: CollectionScope | null,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const spec = collectorSpecForArtifactType(artifactType);
  const before = await snapshotMatchingFiles(collectorsDir, spec.producedFileRe);
  const proc = Bun.spawn(collectorCommandForArtifactType(spec.script, artifactType, collectionScope), {
    cwd: collectorsDir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    signal: options?.signal,
  });
  let code: number;
  try {
    code = await proc.exited;
  } catch (e) {
    if (options?.signal?.aborted) {
      throw new CollectorError(`${spec.script} aborted (lease lost or shutdown)`);
    }
    throw e instanceof Error ? e : new CollectorError(String(e));
  }
  if (code !== 0) {
    throw new CollectorError(`${spec.script} exited with code ${code}`);
  }

  const produced = await pickProducedMatchingFile(
    collectorsDir,
    before,
    spec.producedFileRe
  );
  if (!produced) {
    throw new CollectorError(
      `${spec.script} exited 0 but no new or updated matching artifact was detected (refusing to upload a stale file)`
    );
  }
  return produced;
}

/**
 * Run `first-audit.sh` from signalforge-collectors root (cwd).
 * Returns path to a log file that was **created or updated** by this run (not a stale prior file).
 */
export async function runFirstAuditScript(
  collectorsDir: string,
  options?: { signal?: AbortSignal }
): Promise<string> {
  return runCollectorScript(collectorsDir, "linux-audit-log", null, options);
}

export function collectorSpecForArtifact(artifactType: ArtifactType): {
  script: string;
  producedFileRe: RegExp;
} {
  const { script, producedFileRe } = collectorSpecForArtifactType(artifactType);
  return { script, producedFileRe };
}

export async function runCollectorForArtifactType(
  collectorsDir: string,
  artifactType: ArtifactType,
  collectionScope: CollectionScope | null,
  options?: { signal?: AbortSignal }
): Promise<string> {
  return runCollectorScript(collectorsDir, artifactType, collectionScope, options);
}

function collectorCommandForArtifactType(
  script: string,
  artifactType: ArtifactType,
  collectionScope: CollectionScope | null
): string[] {
  const cmd = ["bash", script];

  if (artifactType === "linux-audit-log") {
    if (collectionScope && collectionScope.kind !== "linux_host") {
      throw new CollectorError("linux-audit-log jobs require collection_scope.kind=linux_host");
    }
    return cmd;
  }

  if (artifactType === "container-diagnostics") {
    if (!collectionScope) return cmd;
    if (collectionScope.kind !== "container_target") {
      throw new CollectorError(
        "container-diagnostics jobs require collection_scope.kind=container_target"
      );
    }
    cmd.push("--container", collectionScope.container_ref);
    if (collectionScope.runtime) {
      cmd.push("--runtime", collectionScope.runtime);
    }
    if (collectionScope.host_hint) {
      cmd.push("--hostname", collectionScope.host_hint);
    }
    return cmd;
  }

  if (!collectionScope) return cmd;
  if (collectionScope.kind !== "kubernetes_scope") {
    throw new CollectorError(
      "kubernetes-bundle jobs require collection_scope.kind=kubernetes_scope"
    );
  }
  cmd.push("--scope", collectionScope.scope_level);
  if (collectionScope.namespace) {
    cmd.push("--namespace", collectionScope.namespace);
  }
  if (collectionScope.kubectl_context) {
    cmd.push("--context", collectionScope.kubectl_context);
  }
  if (collectionScope.cluster_name) {
    cmd.push("--cluster-name", collectionScope.cluster_name);
  }
  if (collectionScope.provider) {
    cmd.push("--provider", collectionScope.provider);
  }
  return cmd;
}
