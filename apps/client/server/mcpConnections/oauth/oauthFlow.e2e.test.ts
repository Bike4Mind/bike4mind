import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomMcpPolicySchema } from '@bike4mind/common';
import { RemoteMcpAuthRequiredError } from '@bike4mind/mcp/remote';
import {
  McpConnection,
  McpOAuthClientRegistration,
  McpOAuthPending,
  mcpConnectionRepository,
} from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import {
  startOAuthFixtureServer,
  type OAuthFixtureOptions,
  type OAuthFixtureServer,
} from '../../../../../b4m-core/mcp/src/remote/__fixtures__/oauthFixtureServer';
import type { CustomMcpContext } from '../customMcpAccess';

/**
 * Sign-in, refresh, revoke and the bad-state cases end to end: a real mongod (the lease and the
 * single-use state are database guarantees) against the fixture authorization server. Only the network
 * pin, token encryption, audit and the MCP server itself are replaced.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const fx = vi.hoisted(() => ({ fetch: undefined as unknown as typeof fetch }));

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value: string | null | undefined) => (value ? `enc:${value}` : null),
  decryptToken: (value: string | null | undefined) => {
    if (value?.startsWith('bad:')) throw new Error('decryption failed');
    return value ? value.replace(/^enc:/, '') : null;
  },
}));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordCircuitBreakerRejection: vi.fn(async () => undefined),
  recordCircuitBreakerTransition: vi.fn(async () => undefined),
}));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({ success: vi.fn(), failure: vi.fn(), rateLimited: vi.fn() }),
  },
}));
vi.mock('./oauthFetch', () => ({
  withOAuthFetch: (_network: unknown, override: typeof fetch | undefined, fn: (f: typeof fetch) => Promise<unknown>) =>
    fn(override ?? fx.fetch),
}));

const { startUserConnectionOAuth } = await import('./startOAuth');
const { completeUserConnectionOAuth } = await import('./completeOAuth');
const { getOAuthAccessToken } = await import('./tokenManager');
const { invokeRemoteMcp } = await import('../invokeRemoteMcp');
const { disconnectUserConnectionOAuth, deleteUserConnection } = await import('../connectionService');

const context: CustomMcpContext = {
  enabled: true,
  policies: [CustomMcpPolicySchema.parse({ mode: 'any' })],
  platformBlockedHosts: [],
  organizationIds: [],
  network: { ownHosts: [], allowHttp: true },
  maxConnectionsPerUser: 20,
};

let mongo: MongoMemoryServer;
let fixture: OAuthFixtureServer;
const user = { id: new mongoose.Types.ObjectId().toString() };
const owner = { ownerType: 'user' as const, ownerKey: user.id };

/** Stands in for the MCP server: it accepts only a bearer token the authorization server currently honours. */
const runner = vi.fn(async (payload: { headers: Record<string, string> }) => {
  const token = payload.headers.Authorization?.replace(/^Bearer /, '') ?? '';
  if (!fixture.isValidAccessToken(token)) throw new RemoteMcpAuthRequiredError({});
  return {
    action: 'listTools' as const,
    result: {
      tools: [{ name: 'echo', description: 'Echoes', inputSchema: { type: 'object' as const } }],
      dropped: [],
      detectedTransport: 'streamable-http' as const,
    },
  };
});
const run = (options: { runner?: typeof runner } = {}) => ({ runner: options.runner ?? runner, context });

async function addConnection(slug: string) {
  const created = await mcpConnectionRepository.create({
    ownerType: 'user',
    ownerKey: user.id,
    userId: user.id,
    slug,
    displayName: slug,
    urlEnc: `enc:${fixture.resourceUrl}`,
    displayUrl: fixture.resourceUrl,
    urlHost: 'oauth.test',
    transport: 'auto',
    auth: { kind: 'none' },
    status: 'pending_auth',
    tools: [],
    enabled: true,
  });
  return created.id;
}

async function boot(options?: OAuthFixtureOptions) {
  fixture = await startOAuthFixtureServer(options);
  fx.fetch = fixture.fetch;
  return addConnection('fixture');
}

/** Start, approve at the fixture, return the redirect the browser would carry back to the SPA route. */
async function approve(id: string, start: { manual?: { clientId: string; clientSecret?: string } } = {}) {
  const { authorizationUrl } = await startUserConnectionOAuth(user, context, id, { fetchFn: fixture.fetch, ...start });
  const response = await fixture.fetch(authorizationUrl, { redirect: 'manual' });
  const back = new URL(response.headers.get('location') ?? '');
  return {
    authorizationUrl: new URL(authorizationUrl),
    params: {
      code: back.searchParams.get('code') ?? '',
      state: back.searchParams.get('state') ?? '',
      iss: back.searchParams.get('iss') ?? undefined,
    },
  };
}
const complete = (params: { code: string; state: string; iss?: string }, as = user) =>
  completeUserConnectionOAuth(as, context, params, { fetchFn: fixture.fetch, discovery: { runner } });

beforeAll(async () => {
  vi.stubEnv('APP_URL', 'https://app.example.com');
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  vi.unstubAllEnvs();
});
afterEach(async () => {
  await fixture?.close();
  fx.fetch = undefined as unknown as typeof fetch;
  await Promise.all([
    McpConnection.deleteMany({}),
    McpOAuthPending.deleteMany({}),
    McpOAuthClientRegistration.deleteMany({}),
  ]);
  runner.mockClear();
});

describe('OAuth sign-in against the fixture authorization server', () => {
  let id: string;
  beforeEach(async () => {
    id = await boot();
  });

  it('signs in, calls, refreshes after a rejection, and revokes both tokens on disconnect', async () => {
    const { authorizationUrl, params } = await approve(id);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(fixture.resourceUrl);
    expect(authorizationUrl.searchParams.get('state')).toBe(params.state);
    expect(fixture.counts.register).toBe(1);

    const pending = await McpOAuthPending.find({ connectionId: id }).select('+codeVerifierEnc').lean();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(pending)).not.toContain(params.state);
    expect(pending[0]?.codeVerifierEnc).toMatch(/^enc:/);

    const connected = await complete(params);
    expect(connected).toMatchObject({
      status: 'connected',
      auth: { kind: 'oauth', oauth: { hasAccessToken: true, hasRefreshToken: true } },
    });
    expect(connected.tools.every(tool => tool.state === 'pending_review' && !tool.enabled)).toBe(true);
    const stored = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    expect(stored?.auth.oauth?.accessTokenEnc).toMatch(/^enc:at_/);
    expect(fixture.counts.authorizationCode).toBe(1);

    // A valid token is used as is.
    await invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run());
    expect(fixture.counts.refresh).toBe(0);

    // The server stops honouring the token before its recorded expiry: one forced refresh, one retry.
    fixture.expireAccessTokens();
    await invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run());
    expect(fixture.counts.refresh).toBe(1);
    expect(fixture.tokenResources.every(resource => resource === fixture.resourceUrl)).toBe(true);

    const before = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    const refreshToken = before?.auth.oauth?.refreshTokenEnc?.replace(/^enc:/, '');
    const accessToken = before?.auth.oauth?.accessTokenEnc?.replace(/^enc:/, '');
    const disconnected = await disconnectUserConnectionOAuth(user, context, id);
    expect(disconnected.status).toBe('pending_auth');
    expect(fixture.revoked).toEqual([refreshToken, accessToken]);
    const after = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    expect(after?.auth.oauth).toMatchObject({ hasAccessToken: false, hasRefreshToken: false });
    expect(after?.auth.oauth?.accessTokenEnc).toBeUndefined();
    expect(after?.auth.oauth?.refreshTokenEnc).toBeUndefined();
  });

  it('five concurrent refreshes make one token request and share the new token', async () => {
    const { params } = await approve(id);
    await complete(params);
    await McpConnection.updateOne({ _id: id }, { $set: { 'auth.oauth.expiresAt': new Date(Date.now() - 1000) } });
    const stale = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    fixture.counts.refresh = 0;

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getOAuthAccessToken(stale!, { network: context.network }))
    );
    expect(fixture.counts.refresh).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(fixture.isValidAccessToken(tokens[0] ?? '')).toBe(true);
    const latest = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    expect(latest?.refreshLease).toBeFalsy();
  });

  it('an invalid_grant on refresh ends in needs_reconnect', async () => {
    const { params } = await approve(id);
    await complete(params);
    await McpConnection.updateOne({ _id: id }, { $set: { 'auth.oauth.expiresAt': new Date(Date.now() - 1000) } });
    fixture.failNextRefresh();
    await expect(
      invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run())
    ).rejects.toMatchObject({ code: 'auth_required' });
    const latest = await mcpConnectionRepository.findByIdForOwner(id, owner);
    expect(latest).toMatchObject({ status: 'needs_reconnect', lastError: { code: 'invalid_grant' } });
  });

  it.each([
    ['ok_error_invalid_grant', 'auth_required'],
    ['ok_error_bad_refresh_token', 'auth_failed'],
  ] as const)(
    'a token endpoint that answers 200 with %s ends the connection in needs_reconnect',
    async (mode, code) => {
      const { params } = await approve(id);
      await complete(params);
      await McpConnection.updateOne({ _id: id }, { $set: { 'auth.oauth.expiresAt': new Date(Date.now() - 1000) } });
      fixture.setTokenMode(mode);
      await expect(
        invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run())
      ).rejects.toMatchObject({ code });
      const latest = await mcpConnectionRepository.findByIdForOwner(id, owner);
      expect(latest?.status).toBe('needs_reconnect');
    }
  );

  describe('a bad state is refused the same way and writes no tokens', () => {
    const expectRefused = async (promise: Promise<unknown>) => {
      await expect(promise).rejects.toMatchObject({ additionalInfo: { code: 'invalid_state' } });
      const stored = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
      expect(stored?.auth.oauth?.accessTokenEnc).toBeUndefined();
      expect(stored?.auth.oauth?.hasAccessToken).toBeFalsy();
      expect(fixture.counts.authorizationCode).toBe(0);
    };

    it('unknown state', async () => {
      const { params } = await approve(id);
      await expectRefused(complete({ ...params, state: 'not-a-state' }));
    });

    it("another user's session, which also cannot burn the real user's attempt", async () => {
      const { params } = await approve(id);
      await expectRefused(complete(params, { id: new mongoose.Types.ObjectId().toString() }));
      expect(await complete(params)).toMatchObject({ status: 'connected' });
    });

    it('an expired state', async () => {
      const { params } = await approve(id);
      await McpOAuthPending.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 3_600_000) } });
      await expectRefused(complete(params));
    });

    it('a replayed state', async () => {
      const { params } = await approve(id);
      await complete(params);
      await expect(complete(params)).rejects.toMatchObject({ additionalInfo: { code: 'invalid_state' } });
      expect(fixture.counts.authorizationCode).toBe(1);
    });
  });
});

describe('lifecycle edges', () => {
  const signIn = async (id: string, start?: Parameters<typeof approve>[1]) => {
    const { params } = await approve(id, start);
    await complete(params);
    return (await mcpConnectionRepository.findByIdWithCredentials(id, owner))!;
  };
  const expire = (id: string) =>
    McpConnection.updateOne({ _id: id }, { $set: { 'auth.oauth.expiresAt': new Date(Date.now() - 1000) } });

  it('refuses a callback whose connection no longer names the issuer the state was issued for', async () => {
    const id = await boot();
    const { params } = await approve(id);
    await McpConnection.updateOne({ _id: id }, { $set: { 'auth.oauth.issuer': 'https://other.example' } });
    await expect(complete(params)).rejects.toMatchObject({ additionalInfo: { code: 'invalid_state' } });
    expect(fixture.counts.authorizationCode).toBe(0);
  });

  it('revokes both tokens when a connected connection is deleted', async () => {
    const id = await boot();
    const before = await signIn(id);
    await deleteUserConnection(user, id);
    expect(fixture.revoked).toEqual([
      before.auth.oauth?.refreshTokenEnc?.replace(/^enc:/, ''),
      before.auth.oauth?.accessTokenEnc?.replace(/^enc:/, ''),
    ]);
    expect(await McpConnection.countDocuments({ _id: id })).toBe(0);
  });

  describe('a transient authorization server failure leaves the sign-in alone', () => {
    it('on refresh: 503 and a network error keep the connection connected with its tokens', async () => {
      const id = await boot();
      const before = await signIn(id);
      await expire(id);

      fixture.setTokenMode('unavailable');
      await expect(
        invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run())
      ).rejects.toMatchObject({ code: 'timeout' });
      fx.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
      await expect(
        invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run())
      ).rejects.toMatchObject({ code: 'timeout' });

      const after = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
      expect(after?.status).toBe('connected');
      expect(after?.auth.oauth?.accessTokenEnc).toBe(before.auth.oauth?.accessTokenEnc);
      expect(after?.auth.oauth?.refreshTokenEnc).toBe(before.auth.oauth?.refreshTokenEnc);

      fixture.setTokenMode('ok');
      fx.fetch = fixture.fetch;
      await invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run());
      expect(fixture.counts.refresh).toBe(1);
    });

    it('on the code exchange: a 503 is reported as unavailable, not as a refused sign-in', async () => {
      const id = await boot();
      const { params } = await approve(id);
      fixture.setTokenMode('unavailable');
      await expect(complete(params)).rejects.toMatchObject({ additionalInfo: { code: 'oauth_token_unavailable' } });
      expect(
        (await mcpConnectionRepository.findByIdWithCredentials(id, owner))?.auth.oauth?.hasAccessToken
      ).toBeFalsy();
    });
  });

  it('signs in, refreshes and revokes a typed client against a server that allows only HTTP Basic', async () => {
    const id = await boot({ basicOnlyClient: { id: 'typed id', secret: 'typed/secret' } });
    const manual = { clientId: 'typed id', clientSecret: 'typed/secret' };
    const signedIn = await signIn(id, { manual });
    expect(signedIn.auth.oauth).toMatchObject({ clientMode: 'manual', tokenEndpointAuthMethod: 'client_secret_basic' });

    await expire(id);
    await invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run());
    expect(fixture.counts.refresh).toBe(1);

    const current = (await mcpConnectionRepository.findByIdWithCredentials(id, owner))?.auth.oauth;
    await disconnectUserConnectionOAuth(user, context, id);
    expect(fixture.revoked).toEqual([
      current?.refreshTokenEnc?.replace(/^enc:/, ''),
      current?.accessTokenEnc?.replace(/^enc:/, ''),
    ]);
  });

  describe('starting again', () => {
    it('with another client ends the old grant instead of pairing it with the new client', async () => {
      const id = await boot();
      const before = await signIn(id);
      fixture.counts.refresh = 0;

      await approve(id, { manual: { clientId: 'typed', clientSecret: 'shh' } }); // abandoned: never completed
      const after = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
      expect(after).toMatchObject({ status: 'pending_auth' });
      expect(after?.auth.oauth).toMatchObject({ clientMode: 'manual', hasAccessToken: false });
      expect(after?.auth.oauth?.refreshTokenEnc).toBeUndefined();
      expect(fixture.revoked).toContain(before.auth.oauth?.refreshTokenEnc?.replace(/^enc:/, ''));

      await expect(
        invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run())
      ).rejects.toMatchObject({ code: 'auth_required' });
      expect(fixture.counts.refresh).toBe(0);
    });

    it('with the same client keeps the working grant until the new one completes', async () => {
      const id = await boot();
      const before = await signIn(id);
      await approve(id); // abandoned
      const after = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
      expect(after?.status).toBe('connected');
      expect(after?.auth.oauth?.refreshTokenEnc).toBe(before.auth.oauth?.refreshTokenEnc);
    });

    it('a connected connection with no authentication is not left connected once it is an OAuth one', async () => {
      const id = await boot();
      await McpConnection.updateOne({ _id: id }, { $set: { status: 'connected' } });
      await approve(id);
      expect((await mcpConnectionRepository.findByIdForOwner(id, owner))?.status).toBe('pending_auth');
    });
  });

  it('two first starts for a new server converge on one registered client', async () => {
    const first = await boot();
    const second = await addConnection('second');
    const [a, b] = await Promise.all([
      startUserConnectionOAuth(user, context, first, { fetchFn: fixture.fetch }),
      startUserConnectionOAuth(user, context, second, { fetchFn: fixture.fetch }),
    ]);
    const clientId = (url: string) => new URL(url).searchParams.get('client_id');
    expect(clientId(a.authorizationUrl)).toBe(clientId(b.authorizationUrl));
    expect(await McpOAuthClientRegistration.countDocuments({})).toBe(1);
    const stored = await Promise.all([first, second].map(id => mcpConnectionRepository.findByIdForOwner(id, owner)));
    expect(new Set(stored.map(c => c?.auth.oauth?.clientRegistrationId)).size).toBe(1);
  });

  it('keeps using the registration a connection signed in with after the server is re-registered', async () => {
    const id = await boot();
    const before = await signIn(id);
    const registrationId = before.auth.oauth?.clientRegistrationId;
    await McpOAuthClientRegistration.create({
      issuer: 'https://elsewhere.example',
      redirectUri: 'https://app.example.com/other',
      clientId: 'someone-else',
      tokenEndpointAuthMethod: 'none',
    });
    await expire(id);
    await invokeRemoteMcp({ action: 'listTools', connectionId: id, userId: user.id }, run());
    expect(fixture.counts.refresh).toBe(1);
    expect((await mcpConnectionRepository.findByIdForOwner(id, owner))?.auth.oauth?.clientRegistrationId).toBe(
      registrationId
    );
  });

  it('disconnects and clears the tokens even when they cannot be decrypted', async () => {
    const id = await boot();
    await signIn(id);
    await McpConnection.updateOne(
      { _id: id },
      { $set: { 'auth.oauth.accessTokenEnc': 'bad:a', 'auth.oauth.refreshTokenEnc': 'bad:r' } }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const disconnected = await disconnectUserConnectionOAuth(user, context, id);
    warn.mockRestore();
    expect(disconnected.status).toBe('pending_auth');
    const after = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    expect(after?.auth.oauth?.accessTokenEnc).toBeUndefined();
    expect(after?.auth.oauth?.refreshTokenEnc).toBeUndefined();
    expect(fixture.revoked).toEqual([]);
  });
});

describe('RFC 9207 issuer check', () => {
  it('refuses a response whose iss names another issuer', async () => {
    const id = await boot({ iss: 'wrong' });
    const { params } = await approve(id);
    expect(params.iss).toBe('https://evil.example');
    await expect(complete(params)).rejects.toMatchObject({ additionalInfo: { code: 'invalid_state' } });
    const stored = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
    expect(stored?.auth.oauth?.hasAccessToken).toBeFalsy();
    expect(fixture.counts.authorizationCode).toBe(0);
  });

  it('refuses a response with no iss when the server promised one, and the failed check burns the state', async () => {
    const id = await boot({ iss: true });
    const { params } = await approve(id);
    await expect(complete({ ...params, iss: undefined })).rejects.toMatchObject({
      additionalInfo: { code: 'invalid_state' },
    });
    // Retrying with the right iss is refused too: the state was consumed by the failed attempt.
    await expect(complete(params)).rejects.toMatchObject({ additionalInfo: { code: 'invalid_state' } });
    expect(fixture.counts.authorizationCode).toBe(0);
  });

  it('accepts a matching iss', async () => {
    const id = await boot({ iss: true });
    const { params } = await approve(id);
    expect(await complete(params)).toMatchObject({ status: 'connected' });
  });
});
