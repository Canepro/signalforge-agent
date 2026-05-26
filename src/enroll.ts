import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApiError, type FetchLike } from "./api.ts";
import { fetchDiscoverySnapshot } from "./discovery.ts";

export type EnrollInput = {
  baseUrl: string;
  sourceId: string;
  displayName?: string | null;
  adminToken: string;
  tokenFile?: string | null;
  printToken?: boolean;
  fetchImpl?: FetchLike;
};

export type EnrollResult = {
  agentId: string;
  sourceId: string;
  tokenPrefix: string;
  tokenFile: string | null;
  registerUri: string;
  scopes: string[];
};

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class EnrollError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(message: string, code: string, httpStatus: number | null = null) {
    super(message);
    this.name = "EnrollError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function enrollCollectionAgent(input: EnrollInput): Promise<EnrollResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const snapshot = await fetchDiscoverySnapshot(input.baseUrl, fetchImpl);
  const registerUri = snapshot.registerUri;

  const res = await fetchImpl(registerUri, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source_id: input.sourceId,
      ...(input.displayName ? { display_name: input.displayName } : {}),
    }),
  });
  const text = await res.text();
  const json = parseJsonSafe(text);

  if (res.status === 409 && json?.code === "source_already_registered") {
    throw new EnrollError(
      "Source already has a collection-agent registration. Reissue the token from SignalForge Sources UI (/sources) or ask an operator to rotate it. Do not retry enroll in a loop.",
      "source_already_registered",
      409
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new EnrollError(
      `Admin authentication failed for ${registerUri} (HTTP ${res.status}). Check SIGNALFORGE_ADMIN_TOKEN.`,
      "admin_auth_failed",
      res.status
    );
  }
  if (!res.ok) {
    throw new ApiError("POST", registerUri, res.status, text, json);
  }

  const token = typeof json?.token === "string" ? json.token : "";
  const agentId = typeof json?.agent_id === "string" ? json.agent_id : "";
  const sourceId = typeof json?.source_id === "string" ? json.source_id : input.sourceId;
  const tokenPrefix = typeof json?.token_prefix === "string" ? json.token_prefix : "";
  const scopes = Array.isArray(json?.scopes) ?
      json.scopes.filter((s): s is string => typeof s === "string")
    : [];

  if (!token || !agentId) {
    throw new EnrollError(
      `Registration succeeded but response was missing token or agent_id from ${registerUri}`,
      "invalid_registration_response",
      res.status
    );
  }

  let tokenFile: string | null = null;
  if (input.tokenFile) {
    tokenFile = resolve(input.tokenFile);
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  }

  if (input.printToken) {
    console.log(token);
  }

  return {
    agentId,
    sourceId,
    tokenPrefix,
    tokenFile,
    registerUri,
    scopes,
  };
}
