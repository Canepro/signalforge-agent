/**
 * auth.md discovery client for SignalForge registration metadata.
 */
import type { FetchLike } from "./api.ts";

export type AgentAuthCompatibility = {
  legacy_register_uri?: string;
  automation_register_uri?: string;
  claim_implemented?: boolean;
};

export type AgentAuthMetadata = {
  register_uri: string;
  claim_uri?: string;
  compatibility?: AgentAuthCompatibility;
};

export type AuthorizationServerMetadata = {
  issuer?: string;
  agent_auth?: AgentAuthMetadata;
  scopes_supported?: string[];
};

export type ProtectedResourceMetadata = {
  resource?: string;
  resource_name?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
};

export type DiscoverySnapshot = {
  baseUrl: string;
  authMdUrl: string;
  protectedResourceUrl: string;
  authorizationServerUrl: string;
  authMdMarkdown: string;
  protectedResource: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  registerUri: string;
  legacyRegisterUri: string | null;
  claimImplemented: boolean;
};

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function readText(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function readJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  const res = await fetchImpl(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`GET ${url} returned invalid JSON`);
  }
}

export async function fetchDiscoverySnapshot(
  baseUrlRaw: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)
): Promise<DiscoverySnapshot> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const authMdUrl = `${baseUrl}/auth.md`;
  const protectedResourceUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
  const authorizationServerUrl = `${baseUrl}/.well-known/oauth-authorization-server`;

  const [authMdMarkdown, protectedResource, authorizationServer] = await Promise.all([
    readText(fetchImpl, authMdUrl),
    readJson<ProtectedResourceMetadata>(fetchImpl, protectedResourceUrl),
    readJson<AuthorizationServerMetadata>(fetchImpl, authorizationServerUrl),
  ]);

  const registerUri =
    authorizationServer.agent_auth?.register_uri?.trim() ||
    `${baseUrl}/agent/auth`;
  const legacyRegisterUri =
    authorizationServer.agent_auth?.compatibility?.legacy_register_uri?.trim() ||
    null;
  const claimImplemented =
    authorizationServer.agent_auth?.compatibility?.claim_implemented === true;

  return {
    baseUrl,
    authMdUrl,
    protectedResourceUrl,
    authorizationServerUrl,
    authMdMarkdown,
    protectedResource,
    authorizationServer,
    registerUri,
    legacyRegisterUri,
    claimImplemented,
  };
}

export function formatDiscoverySummary(snapshot: DiscoverySnapshot): string {
  const scopes =
    snapshot.protectedResource.scopes_supported?.join(", ") || "(none listed)";
  const lines = [
    `base_url=${snapshot.baseUrl}`,
    `resource_name=${snapshot.protectedResource.resource_name ?? "SignalForge"}`,
    `register_uri=${snapshot.registerUri}`,
    `legacy_register_uri=${snapshot.legacyRegisterUri ?? "(none)"}`,
    `claim_implemented=${snapshot.claimImplemented}`,
    `scopes_supported=${scopes}`,
    `auth_md_bytes=${snapshot.authMdMarkdown.length}`,
  ];
  return lines.join("\n");
}
