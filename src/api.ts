/**
 * SignalForge agent HTTP client (source-bound Bearer).
 * `fetchImpl` is injectable for tests.
 */
import { parseCollectionScope, type CollectionScope } from "./collection-scope.ts";

export type UploadTransport = "fetch" | "curl";

type CurlUploadRequest = {
  url: string;
  token: string;
  filePath: string;
  filename: string;
  instanceId: string;
  artifactType: string;
};

type CurlUploadResponse = {
  status: number;
  bodyText: string;
};

export type CurlRunner = (
  request: CurlUploadRequest
) => Promise<CurlUploadResponse>;

export class ApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly bodyText: string;
  readonly bodyJson: Record<string, unknown> | null;

  constructor(
    method: string,
    path: string,
    status: number,
    bodyText: string,
    bodyJson: Record<string, unknown> | null
  ) {
    const hint = bodyJson?.code != null ? ` code=${String(bodyJson.code)}` : "";
    super(`${method} ${path} -> HTTP ${status}${hint}`);
    this.name = "ApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.bodyText = bodyText;
    this.bodyJson = bodyJson;
  }
}

export class AuthError extends ApiError {
  constructor(
    method: string,
    path: string,
    status: number,
    bodyText: string,
    bodyJson: Record<string, unknown> | null
  ) {
    super(method, path, status, bodyText, bodyJson);
    this.name = "AuthError";
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isRetryableApiFailure(error: unknown): boolean {
  if (error instanceof AuthError) return false;
  if (error instanceof ApiError) {
    return RETRYABLE_HTTP_STATUSES.has(error.status);
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "TypeError" ||
    "cause" in error ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    message.includes("socket hang up")
  );
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type AgentJobSummary = {
  id: string;
  artifact_type: string;
  collection_scope: CollectionScope | null;
};

async function defaultCurlRunner(
  request: CurlUploadRequest
): Promise<CurlUploadResponse> {
  const proc = Bun.spawn(
    [
      "curl",
      "-sS",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${request.token}`,
      "-F",
      `file=@${request.filePath};filename=${request.filename}`,
      "--form-string",
      `instance_id=${request.instanceId}`,
      "--form-string",
      `artifact_type=${request.artifactType}`,
      "-w",
      "\\n%{http_code}",
      request.url,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || `curl exited with code ${exitCode}`;
    throw new Error(`curl upload failed: ${detail}`);
  }

  const splitAt = stdout.lastIndexOf("\n");
  if (splitAt === -1) {
    throw new Error("curl upload failed: missing HTTP status trailer");
  }
  const bodyText = stdout.slice(0, splitAt);
  const statusText = stdout.slice(splitAt + 1).trim();
  const status = Number.parseInt(statusText, 10);
  if (!Number.isFinite(status)) {
    throw new Error(`curl upload failed: invalid HTTP status trailer "${statusText}"`);
  }

  return { status, bodyText };
}

export class SignalForgeAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly uploadTransport: UploadTransport,
    private readonly curlRunner: CurlRunner
  ) {}

  private authHeaders(contentTypeJson: boolean): HeadersInit {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    if (contentTypeJson) {
      h["content-type"] = "application/json";
    }
    return h;
  }

  private async requestJson(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.authHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    const json = parseJsonSafe(text);
    if (res.status === 401) {
      throw new AuthError(method, path, res.status, text, json);
    }
    if (!res.ok) {
      throw new ApiError(method, path, res.status, text, json);
    }
    return json ?? {};
  }

  async heartbeat(payload: {
    capabilities: string[];
    attributes: Record<string, unknown>;
    agent_version: string;
    active_job_id: string | null;
    instance_id?: string | null;
  }): Promise<Record<string, unknown>> {
    const body = { ...payload };
    if (body.active_job_id == null) {
      delete (body as { instance_id?: string }).instance_id;
    }
    return this.requestJson("POST", "/api/agent/heartbeat", body) as Promise<
      Record<string, unknown>
    >;
  }

  async jobsNext(
    limit: number,
    waitSeconds = 0
  ): Promise<{ jobs: AgentJobSummary[]; gate: string | null }> {
    const data = (await this.requestJson(
      "GET",
      `/api/agent/jobs/next?limit=${encodeURIComponent(String(limit))}&wait_seconds=${encodeURIComponent(String(waitSeconds))}`
    )) as Record<string, unknown>;
    if (!Array.isArray(data.jobs)) {
      throw new Error("GET /api/agent/jobs/next returned an invalid jobs payload");
    }
    const jobs = data.jobs.map((job, index) => {
      if (!job || typeof job !== "object") {
        throw new Error(`GET /api/agent/jobs/next returned malformed job entry at index ${index}`);
      }
      const row = job as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.artifact_type !== "string") {
        throw new Error(`GET /api/agent/jobs/next returned malformed job entry at index ${index}`);
      }
      return {
        id: row.id,
        artifact_type: row.artifact_type,
        collection_scope: parseCollectionScope(row.collection_scope),
      } satisfies AgentJobSummary;
    });
    const gate = data.gate == null || data.gate === null ? null : String(data.gate);
    return { jobs, gate };
  }

  async claim(jobId: string, instanceId: string, leaseTtlSeconds: number): Promise<unknown> {
    return this.requestJson("POST", `/api/collection-jobs/${jobId}/claim`, {
      instance_id: instanceId,
      lease_ttl_seconds: leaseTtlSeconds,
    });
  }

  async start(jobId: string, instanceId: string): Promise<unknown> {
    return this.requestJson("POST", `/api/collection-jobs/${jobId}/start`, {
      instance_id: instanceId,
    });
  }

  async fail(
    jobId: string,
    instanceId: string,
    code: string,
    message: string
  ): Promise<unknown> {
    return this.requestJson("POST", `/api/collection-jobs/${jobId}/fail`, {
      instance_id: instanceId,
      code,
      message,
    });
  }

  async uploadArtifact(
    jobId: string,
    instanceId: string,
    artifactType: string,
    filePath: string,
    filename: string
  ): Promise<Record<string, unknown>> {
    const path = `/api/collection-jobs/${jobId}/artifact`;
    const url = `${this.baseUrl}${path}`;

    let status: number;
    let text: string;

    if (this.uploadTransport === "curl") {
      const response = await this.curlRunner({
        url,
        token: this.token,
        filePath,
        filename,
        instanceId,
        artifactType,
      });
      status = response.status;
      text = response.bodyText;
    } else {
      const file = Bun.file(filePath);
      const form = new FormData();
      form.set("file", file, filename);
      form.set("instance_id", instanceId);
      form.set("artifact_type", artifactType);

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
        },
        body: form,
      });
      status = res.status;
      text = await res.text();
    }

    const json = parseJsonSafe(text);
    if (status === 401) {
      throw new AuthError("POST", path, status, text, json);
    }
    if (status < 200 || status >= 300) {
      throw new ApiError(
        "POST",
        path,
        status,
        text,
        json
      );
    }
    return (json ?? {}) as Record<string, unknown>;
  }
}

export function createClient(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  options: {
    uploadTransport?: UploadTransport;
    curlRunner?: CurlRunner;
  } = {}
): SignalForgeAgentClient {
  return new SignalForgeAgentClient(
    baseUrl,
    token,
    fetchImpl,
    options.uploadTransport ?? "fetch",
    options.curlRunner ?? defaultCurlRunner
  );
}
