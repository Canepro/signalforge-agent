import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export class CollectorError extends Error {
  override readonly name = "CollectorError";
}

const AUDIT_LOG_RE = /^server_audit_\d{8}_\d{6}\.log$/;

/**
 * Basename → mtimeMs for existing audit logs before a collector run.
 */
export async function snapshotAuditLogs(dir: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!AUDIT_LOG_RE.test(name)) continue;
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

/**
 * After a collector run: newest matching log that is new or has a strictly newer mtime than before.
 */
export async function pickProducedAuditLog(
  dir: string,
  before: Map<string, number>
): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!AUDIT_LOG_RE.test(name)) continue;
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

/**
 * Run `first-audit.sh` from signalforge-collectors root (cwd).
 * Returns path to a log file that was **created or updated** by this run (not a stale prior file).
 */
export async function runFirstAuditScript(
  collectorsDir: string,
  options?: { signal?: AbortSignal }
): Promise<string> {
  const before = await snapshotAuditLogs(collectorsDir);
  const proc = Bun.spawn(["bash", "first-audit.sh"], {
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
      throw new CollectorError("first-audit.sh aborted (lease lost or shutdown)");
    }
    throw e instanceof Error ? e : new CollectorError(String(e));
  }
  if (code !== 0) {
    throw new CollectorError(`first-audit.sh exited with code ${code}`);
  }

  const logPath = await pickProducedAuditLog(collectorsDir, before);
  if (!logPath) {
    throw new CollectorError(
      "first-audit.sh exited 0 but no new or updated server_audit_YYYYMMDD_HHMMSS.log was detected (refusing to upload a stale log)"
    );
  }
  return logPath;
}
