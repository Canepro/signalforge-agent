import type { AgentConfig } from "./config.ts";
import type { FixActionSummary, KubernetesFixActionPayload } from "./api.ts";

export const POLICY_DISABLE_SERVICE_ACCOUNT_TOKEN_AUTOMOUNT =
  "kubernetes.disable-service-account-token-automount.v1";

const AUTOMOUNT_FIELD = "spec.template.spec.automountServiceAccountToken";
const SUPPORTED_WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

export class FixActionError extends Error {
  override readonly name = "FixActionError";
}

type KubectlResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type FixExecutionSummary = {
  resource: string;
  namespace: string;
  operation: "server_side_apply";
  changed_fields: string[];
  server_side_apply: true;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ?
      value as Record<string, unknown>
    : null;
}

function validatePayload(action: FixActionSummary): KubernetesFixActionPayload {
  const payload = action.action_payload;
  if (action.policy_id !== POLICY_DISABLE_SERVICE_ACCOUNT_TOKEN_AUTOMOUNT) {
    throw new FixActionError(`unsupported fix policy: ${action.policy_id}`);
  }
  if (
    payload.kind !== "kubernetes_safe_patch" ||
    payload.policy_id !== action.policy_id ||
    payload.action_kind !== "kubernetes_patch" ||
    action.action_kind !== "kubernetes_patch"
  ) {
    throw new FixActionError("fix action payload does not match the queued action");
  }
  if (
    payload.patch_template.kind !== "kubernetes_patch_template" ||
    payload.patch_template.patch_type !== "server_side_apply"
  ) {
    throw new FixActionError("fix action payload is not a server-side Kubernetes patch");
  }
  if (
    payload.changed_fields.length !== 1 ||
    payload.changed_fields[0] !== AUTOMOUNT_FIELD
  ) {
    throw new FixActionError("fix action payload changes fields outside the allowlist");
  }

  const { target } = payload;
  if (
    !SUPPORTED_WORKLOAD_KINDS.has(target.kind) ||
    !target.api_version ||
    !target.namespace ||
    !target.name ||
    target.resource !== `${target.kind.toLowerCase()}/${target.name}`
  ) {
    throw new FixActionError("fix action payload has an unsupported or incomplete target");
  }

  const manifest = payload.patch_template.manifest;
  const metadata = asRecord(manifest.metadata);
  const spec = asRecord(manifest.spec);
  const template = asRecord(spec?.template);
  const podSpec = asRecord(template?.spec);
  if (
    manifest.apiVersion !== target.api_version ||
    manifest.kind !== target.kind ||
    metadata?.name !== target.name ||
    metadata?.namespace !== target.namespace ||
    podSpec?.automountServiceAccountToken !== false
  ) {
    throw new FixActionError("fix action manifest does not match the approved target and field");
  }

  return payload;
}

function kubectlArgs(cfg: AgentConfig, payload: KubernetesFixActionPayload, mode: "dry-run" | "apply"): string[] {
  const args = [cfg.kubectlBin];
  if (payload.target.kubectl_context) {
    args.push("--context", payload.target.kubectl_context);
  }
  args.push("apply", "--server-side");
  if (mode === "dry-run") {
    args.push("--dry-run=server");
  }
  args.push("-f", "-");
  return args;
}

async function runKubectl(args: string[], manifest: Record<string, unknown>): Promise<KubectlResult> {
  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(process.env.KUBECONFIG || !process.env.SIGNALFORGE_KUBECONFIG ?
        {}
      : { KUBECONFIG: process.env.SIGNALFORGE_KUBECONFIG }),
    },
  });
  proc.stdin.write(`${JSON.stringify(manifest, null, 2)}\n`);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    ok: exitCode === 0,
    stdout,
    stderr,
    exitCode,
  };
}

function summaryFor(payload: KubernetesFixActionPayload): FixExecutionSummary {
  return {
    resource: payload.target.resource,
    namespace: payload.target.namespace,
    operation: "server_side_apply",
    changed_fields: [...payload.changed_fields],
    server_side_apply: true,
  };
}

export async function dryRunFixAction(
  cfg: AgentConfig,
  action: FixActionSummary
): Promise<{ status: "passed" | "failed"; summary: Record<string, unknown> }> {
  const payload = validatePayload(action);
  const result = await runKubectl(kubectlArgs(cfg, payload, "dry-run"), payload.patch_template.manifest);
  return {
    status: result.ok ? "passed" : "failed",
    summary: {
      ...summaryFor(payload),
      exit_code: result.exitCode,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
    },
  };
}

export async function applyFixAction(
  cfg: AgentConfig,
  action: FixActionSummary
): Promise<{ status: "applied" | "failed"; summary: Record<string, unknown> }> {
  const payload = validatePayload(action);
  const result = await runKubectl(kubectlArgs(cfg, payload, "apply"), payload.patch_template.manifest);
  return {
    status: result.ok ? "applied" : "failed",
    summary: {
      ...summaryFor(payload),
      exit_code: result.exitCode,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
    },
  };
}
