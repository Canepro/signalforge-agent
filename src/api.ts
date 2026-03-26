/**
 * SignalForge agent HTTP client (source-bound Bearer).
 * `fetchImpl` is injectable for tests.
 */

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

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export class SignalForgeAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike
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
  ): Promise<{ jobs: unknown[]; gate: string | null }> {
    const data = (await this.requestJson(
      "GET",
      `/api/agent/jobs/next?limit=${encodeURIComponent(String(limit))}&wait_seconds=${encodeURIComponent(String(waitSeconds))}`
    )) as Record<string, unknown>;
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
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
    const url = `${this.baseUrl}/api/collection-jobs/${jobId}/artifact`;
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
    const text = await res.text();
    const json = parseJsonSafe(text);
    if (res.status === 401) {
      throw new AuthError("POST", `/api/collection-jobs/${jobId}/artifact`, res.status, text, json);
    }
    if (!res.ok) {
      throw new ApiError(
        "POST",
        `/api/collection-jobs/${jobId}/artifact`,
        res.status,
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
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)
): SignalForgeAgentClient {
  return new SignalForgeAgentClient(baseUrl, token, fetchImpl);
}
