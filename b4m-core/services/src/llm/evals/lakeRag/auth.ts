/**
 * The live driver's credential: a `b4m_live_` API key when one is supplied, otherwise a throwaway
 * user minted through the gated E2E route (apps/client/pages/api/test/create-user.ts), which only
 * answers on a stage with E2E endpoints enabled.
 */
import { bodyExcerpt, lakeRagUrl, type LakeRagCredential } from './http';

export type LakeRagAuthOptions = {
  baseUrl: string;
  apiKey?: string;
  e2eCleanupSecret?: string;
  /** Scopes the throwaway user and its cleanup; generated when omitted. Letters and digits only. */
  testId?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export type LakeRagAuth = {
  /** The header for an API key; a renewing credential for the e2e user's short-lived JWT. */
  authorization: string | LakeRagCredential;
  source: 'api-key' | 'e2e-user';
  /** Deletes the throwaway user and its data, lakes included; a no-op for an API key. Runs at most once. */
  cleanup(): Promise<void>;
};

const API_KEY_PREFIX = 'b4m_live_';
const SECRET_HEADER = 'x-e2e-cleanup-secret';
// The cleanup route strips everything outside this class, so anything else would scope a
// different user set than the one created (apps/client/server/utils/e2eCleanupScope.ts).
const TEST_ID = /^[a-zA-Z0-9]+$/;
// Body-transport refresh (apps/client/pages/api/auth/refreshToken.ts): rotates the opaque refresh
// token create-user issues and returns the rotated one in the body.
const REFRESH_PATH = '/api/auth/refreshToken';
// Access-token TTL (apps/client/server/auth/tokenGenerator.ts), used when the JWT carries no `exp`.
const FALLBACK_TTL_MS = 30 * 60 * 1000;
const RENEW_BEFORE_MS = 5 * 60 * 1000;

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The JWT's `exp` in ms, or `issuedAt` plus the default TTL when it cannot be read. */
export function jwtExpiryMs(token: string, issuedAt: number): number {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))) as { exp?: unknown };
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000;
  } catch {
    // Not a decodable JWT: fall through to the default TTL.
  }
  return issuedAt + FALLBACK_TTL_MS;
}

export async function resolveLakeRagAuth(opts: LakeRagAuthOptions): Promise<LakeRagAuth> {
  const apiKey = opts.apiKey?.trim();
  if (apiKey) {
    if (!apiKey.startsWith(API_KEY_PREFIX)) throw new Error(`LakeRag auth: API key must start with ${API_KEY_PREFIX}`);
    return { authorization: `Bearer ${apiKey}`, source: 'api-key', cleanup: async () => {} };
  }

  const secret = opts.e2eCleanupSecret?.trim();
  if (!secret) throw new Error('LakeRag auth: set an API key or the E2E cleanup secret');
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const digits = now();
  const testId = opts.testId ?? `lakerag${digits.toString(36)}`;
  // An empty testId would make the cleanup route sweep every ephemeral e2e user.
  if (!TEST_ID.test(testId)) throw new Error('LakeRag auth: testId must be letters and digits only');
  const createUrl = lakeRagUrl(opts.baseUrl, '/api/test/create-user');

  let cleanupRun: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupRun ??= (async () => {
      const url = lakeRagUrl(opts.baseUrl, '/api/test/cleanup');
      url.searchParams.set('testId', testId);
      const out = await fetchImpl(url, { method: 'DELETE', headers: { [SECRET_HEADER]: secret } });
      if (!out.ok) throw new Error(`LakeRag auth: cleanup ${testId} -> ${out.status}`);
    })());

  const handle = `lakerag-${testId}-${digits}-e2e`;
  const res = await fetchImpl(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: secret },
    body: JSON.stringify({
      username: handle,
      email: `${handle}@test.com`,
      name: 'Lake RAG eval',
      password: globalThis.crypto.randomUUID(),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LakeRag auth: create-user -> ${res.status}: ${bodyExcerpt(text)}`);
  const created = parseJson(text);
  let access = nonEmpty(created.accessToken);
  let refresh = nonEmpty(created.refreshToken);
  if (!access || !refresh) {
    // The user may exist even though the body is unusable; nothing else would sweep it.
    await cleanup().catch(() => {});
    throw new Error(`LakeRag auth: create-user returned no ${access ? 'refreshToken' : 'accessToken'}`);
  }

  let expiresAt = jwtExpiryMs(access, now());
  let renewing: Promise<boolean> | undefined;
  const renewNow = () =>
    (renewing ??= (async () => {
      try {
        const out = await fetchImpl(lakeRagUrl(opts.baseUrl, REFRESH_PATH), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }),
        });
        const body = parseJson(await out.text());
        const next = out.ok ? nonEmpty(body.accessToken) : undefined;
        if (!next) return false;
        access = next;
        // Absent when a concurrent refresh already rotated the chain; the held token stays live.
        refresh = nonEmpty(body.refreshToken) ?? refresh;
        expiresAt = jwtExpiryMs(next, now());
        return true;
      } finally {
        renewing = undefined;
      }
    })());

  const authorization: LakeRagCredential = {
    async header() {
      if (now() >= expiresAt - RENEW_BEFORE_MS) await renewNow();
      return `Bearer ${access}`;
    },
    async renew(rejected) {
      if (rejected !== `Bearer ${access}`) return true;
      return renewNow();
    },
  };
  return { authorization, source: 'e2e-user', cleanup };
}
