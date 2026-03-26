import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { runCollectorForArtifactType } from "../src/collector.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

describe("runCollectorForArtifactType", () => {
  test("passes explicit container scope as collector flags", async () => {
    const dir = await makeTempDir("sf-agent-collector-");
    const capturePath = join(dir, "args.txt");
    await writeExecutable(
      join(dir, "collect-container-diagnostics.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > '${capturePath}'
printf 'ok\n' > ./container_diagnostics_payments-api_20260326_220000.txt
`
    );

    const artifact = await runCollectorForArtifactType(dir, "container-diagnostics", {
      kind: "container_target",
      container_ref: "payments-api",
      runtime: "podman",
      host_hint: "runtime-a",
    });

    expect(artifact).toContain("container_diagnostics_payments-api_20260326_220000.txt");
    expect(await readFile(capturePath, "utf8")).toContain(
      "--container payments-api --runtime podman --hostname runtime-a"
    );
  });

  test("passes explicit kubernetes scope as collector flags", async () => {
    const dir = await makeTempDir("sf-agent-k8s-collector-");
    const capturePath = join(dir, "args.txt");
    await writeExecutable(
      join(dir, "collect-kubernetes-bundle.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > '${capturePath}'
printf '{}\n' > ./kubernetes_bundle_payments_20260326_220000.json
`
    );

    const artifact = await runCollectorForArtifactType(dir, "kubernetes-bundle", {
      kind: "kubernetes_scope",
      scope_level: "namespace",
      namespace: "payments",
      kubectl_context: "prod-eu-1",
      cluster_name: "aks-prod-eu-1",
      provider: "aks",
    });

    expect(artifact).toContain("kubernetes_bundle_payments_20260326_220000.json");
    expect(await readFile(capturePath, "utf8")).toContain(
      "--scope namespace --namespace payments --context prod-eu-1 --cluster-name aks-prod-eu-1 --provider aks"
    );
  });
});
