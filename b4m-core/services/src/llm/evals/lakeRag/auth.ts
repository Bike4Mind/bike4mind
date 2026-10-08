/**
 * The live driver's credential: a `b4m_live_` API key when one is supplied, otherwise a throwaway
 * user minted through the gated E2E route (apps/client/pages/api/test/create-user.ts), which only
 * answers on a stage with E2E endpoints enabled.
 */

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
  /** Full Authorization header value. */
  authorization: string;
  source: 'api-key' | 'e2e-user';
  /** Deletes the throwaway user and its data; a no-op for an API key. Runs at most once. */
  cleanup(): Promise<void>;
};

const API_KEY_PREFIX = 'b4m_live_';
const SECRET_HEADER = 'x-e2e-cleanup-secret';
// The cleanup route strips everything outside this class, so anything else would scope a
// different user set than the one created (apps/client/server/utils/e2eCleanupScope.ts).
const TEST_ID = /^[a-zA-Z0-9]+$/;

/**
 * The JWT from create-user has no refresh path here, so a run that outlives its access token
 * starts failing with 401s.
 */
export async function resolveLakeRagAuth(opts: LakeRagAuthOptions): Promise<LakeRagAuth> {
  const apiKey = opts.apiKey?.trim();
  if (apiKey) {
    if (!apiKey.startsWith(API_KEY_PREFIX)) throw new Error(`LakeRag auth: API key must start with ${API_KEY_PREFIX}`);
    return { authorization: `Bearer ${apiKey}`, source: 'api-key', cleanup: async () => {} };
  }

  const secret = opts.e2eCleanupSecret?.trim();
  if (!secret) throw new Error('LakeRag auth: set an API key or the E2E cleanup secret');
  const fetchImpl = opts.fetch ?? fetch;
  const digits = (opts.now ?? Date.now)();
  const testId = opts.testId ?? `lakerag${digits.toString(36)}`;
  // An empty testId would make the cleanup route sweep every ephemeral e2e user.
  if (!TEST_ID.test(testId)) throw new Error('LakeRag auth: testId must be letters and digits only');

  const handle = `lakerag-${testId}-${digits}-e2e`;
  const res = await fetchImpl(new URL('/api/test/create-user', opts.baseUrl), {
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
  if (!res.ok) throw new Error(`LakeRag auth: create-user -> ${res.status}: ${text.slice(0, 300)}`);
  const { accessToken } = JSON.parse(text) as { accessToken?: unknown };
  if (typeof accessToken !== 'string' || !accessToken)
    throw new Error('LakeRag auth: create-user returned no accessToken');

  let cleanupRun: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupRun ??= (async () => {
      const url = new URL('/api/test/cleanup', opts.baseUrl);
      url.searchParams.set('testId', testId);
      const out = await fetchImpl(url, { method: 'DELETE', headers: { [SECRET_HEADER]: secret } });
      if (!out.ok) throw new Error(`LakeRag auth: cleanup ${testId} -> ${out.status}`);
    })());

  return { authorization: `Bearer ${accessToken}`, source: 'e2e-user', cleanup };
}
