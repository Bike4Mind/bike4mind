import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteMcpOAuthError } from '@bike4mind/mcp/remote';

const h = vi.hoisted(() => ({
  repo: {
    findByIdWithCredentials: vi.fn(),
    setOAuthConfig: vi.fn(),
    clearOAuthTokens: vi.fn(),
  },
  pending: { create: vi.fn() },
  discover: vi.fn(),
  build: vi.fn(),
  resolveClient: vi.fn(),
  loadClient: vi.fn(),
  assertPolicy: vi.fn(),
  auditEntry: { success: vi.fn(), failure: vi.fn() },
  revoke: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  mcpConnectionRepository: h.repo,
  mcpOAuthPendingRepository: h.pending,
}));
vi.mock('@bike4mind/mcp/remote', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/mcp/remote')>()),
  discoverRemoteMcpOAuth: h.discover,
  buildRemoteMcpAuthorizationUrl: h.build,
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value?: string | null) => (value ? `enc:${value}` : null),
  decryptToken: (value?: string | null) => (value ? value.replace(/^enc:/, '') : null),
}));
vi.mock('../connectionService', () => ({
  assertPolicyAllows: h.assertPolicy,
  audit: () => h.auditEntry,
  userOwner: (id: string) => ({ ownerType: 'user', ownerKey: id }),
}));
vi.mock('../invokeRemoteMcp', () => ({ cleanScope: (scope: string) => scope }));
vi.mock('./clientIdentity', () => ({ loadConnectionClient: h.loadClient, resolveOAuthClient: h.resolveClient }));
vi.mock('./oauthFetch', () => ({
  withOAuthFetch: (_n: unknown, override: unknown, fn: (f: unknown) => Promise<unknown>) => fn(override),
}));
vi.mock('./redirectUri', () => ({ redirectUri: () => 'https://app.example.com/integrations/mcp-oauth-callback' }));
vi.mock('./revoke', () => ({ revokeConnectionGrant: h.revoke }));

import { BadGatewayError, ConflictError, NotFoundError } from '@bike4mind/common';
import { sha256Hex, startUserConnectionOAuth } from './startOAuth';

const actor = { id: 'u1' } as never;
const context = { network: {} } as never;
const discovery = (extra: Record<string, unknown> = {}) => ({
  resource: 'https://mcp.example/mcp',
  issuer: 'https://as.example',
  authorizationServerUrl: 'https://as.example',
  tokenEndpoint: 'https://as.example/token',
  issParameterSupported: false,
  scopesSupported: ['read', 'write'],
  ...extra,
});
const conn = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  urlEnc: 'enc:https://mcp.example/mcp',
  displayUrl: 'https://mcp.example/mcp',
  auth: { kind: 'none' },
  ...overrides,
});
const resolved = {
  mode: 'dcr',
  client: { clientId: 'cid', tokenEndpointAuthMethod: 'none' },
  clientRegistrationId: 'reg-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.repo.findByIdWithCredentials.mockResolvedValue(conn());
  h.repo.setOAuthConfig.mockResolvedValue({ id: 'c1' });
  h.discover.mockResolvedValue(discovery());
  h.resolveClient.mockResolvedValue(resolved);
  h.build.mockImplementation(async (_d: unknown, o: { state: string }) => ({
    authorizationUrl: `https://as.example/authorize?state=${o.state}`,
    codeVerifier: 'verifier',
  }));
  h.pending.create.mockResolvedValue({});
});

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e
  );

describe('startUserConnectionOAuth', () => {
  it('stores the config and a pending row keyed by the hash of the state, with the verifier encrypted', async () => {
    const { authorizationUrl } = await startUserConnectionOAuth(actor, context, 'c1');
    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    expect(h.pending.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stateHash: sha256Hex(state),
        userId: 'u1',
        connectionId: 'c1',
        codeVerifierEnc: 'enc:verifier',
        issuer: 'https://as.example',
      })
    );
    expect(JSON.stringify(h.pending.create.mock.calls)).not.toContain(state);
    expect(h.repo.setOAuthConfig).toHaveBeenCalledWith(
      'c1',
      { ownerType: 'user', ownerKey: 'u1' },
      expect.objectContaining({ issuer: 'https://as.example', clientMode: 'dcr', clientRegistrationId: 'reg-1' })
    );
  });

  it('refuses an unknown connection', async () => {
    h.repo.findByIdWithCredentials.mockResolvedValue(null);
    expect(await refusal(startUserConnectionOAuth(actor, context, 'c1'))).toBeInstanceOf(NotFoundError);
  });

  it('refuses an API-key connection with not_oauth, before any discovery', async () => {
    h.repo.findByIdWithCredentials.mockResolvedValue(conn({ auth: { kind: 'api_key' } }));
    const error = await refusal(startUserConnectionOAuth(actor, context, 'c1'));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ additionalInfo: { code: 'not_oauth' } });
    expect(h.discover).not.toHaveBeenCalled();
  });

  it('stops when the organisation policy refuses the host, writing nothing', async () => {
    h.assertPolicy.mockImplementationOnce(() => {
      throw new Error('blocked by policy');
    });
    await expect(startUserConnectionOAuth(actor, context, 'c1')).rejects.toThrow('blocked by policy');
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.repo.setOAuthConfig).not.toHaveBeenCalled();
    expect(h.pending.create).not.toHaveBeenCalled();
  });

  it('maps a discovery failure to oauth_discovery_failed and writes nothing', async () => {
    h.discover.mockRejectedValue(new RemoteMcpOAuthError('discovery_failed', 'no metadata'));
    const error = await refusal(startUserConnectionOAuth(actor, context, 'c1'));
    expect(error).toBeInstanceOf(BadGatewayError);
    expect(error).toMatchObject({ additionalInfo: { code: 'oauth_discovery_failed' } });
    expect(h.repo.setOAuthConfig).not.toHaveBeenCalled();
    expect(h.pending.create).not.toHaveBeenCalled();
  });

  describe('which client signs in', () => {
    it('passes a client the user typed to the resolver', async () => {
      await startUserConnectionOAuth(actor, context, 'c1', { manual: { clientId: 'typed', clientSecret: 'shh' } });
      expect(h.resolveClient).toHaveBeenCalledWith(
        expect.objectContaining({ manual: { clientId: 'typed', clientSecret: 'shh' } })
      );
    });

    it('reuses the stored typed client when the user supplies none', async () => {
      h.repo.findByIdWithCredentials.mockResolvedValue(
        conn({ auth: { kind: 'oauth', oauth: { clientMode: 'manual', issuer: 'https://as.example' } } })
      );
      h.loadClient.mockResolvedValue({
        clientId: 'stored',
        clientSecret: 'sec',
        tokenEndpointAuthMethod: 'client_secret_basic',
      });
      await startUserConnectionOAuth(actor, context, 'c1');
      expect(h.resolveClient).toHaveBeenCalledWith(
        expect.objectContaining({ manual: { clientId: 'stored', clientSecret: 'sec' } })
      );
    });

    it('does not reuse a stored client of another mode', async () => {
      h.repo.findByIdWithCredentials.mockResolvedValue(
        conn({ auth: { kind: 'oauth', oauth: { clientMode: 'dcr', issuer: 'https://as.example' } } })
      );
      h.loadClient.mockResolvedValue({ clientId: 'dcr-client' });
      await startUserConnectionOAuth(actor, context, 'c1');
      expect(h.resolveClient).toHaveBeenCalledWith(expect.objectContaining({ manual: undefined }));
    });
  });

  describe('scope choice', () => {
    const scopesOfLastRequest = () => h.build.mock.calls.at(-1)?.[1].scopes;

    it('asks for what the 401 challenge named', async () => {
      h.repo.findByIdWithCredentials.mockResolvedValue(
        conn({ authChallenge: { scope: 'files:read files:read admin' } })
      );
      await startUserConnectionOAuth(actor, context, 'c1');
      expect(scopesOfLastRequest()).toEqual(['files:read', 'admin']);
      expect(h.resolveClient).toHaveBeenCalledWith(expect.objectContaining({ scope: 'files:read admin' }));
    });

    it('falls back to what the server advertises', async () => {
      await startUserConnectionOAuth(actor, context, 'c1');
      expect(scopesOfLastRequest()).toEqual(['read', 'write']);
    });
  });

  describe('a grant that already exists', () => {
    const signedIn = () =>
      conn({
        auth: {
          kind: 'oauth',
          oauth: {
            issuer: 'https://as.example',
            clientMode: 'dcr',
            clientRegistrationId: 'reg-1',
            accessTokenEnc: 'enc:at',
            refreshTokenEnc: 'enc:rt',
          },
        },
      });

    it('is kept when the same server and client sign in again', async () => {
      h.repo.findByIdWithCredentials.mockResolvedValue(signedIn());
      h.loadClient.mockResolvedValue({ clientId: 'cid' });
      await startUserConnectionOAuth(actor, context, 'c1');
      expect(h.revoke).not.toHaveBeenCalled();
      expect(h.repo.clearOAuthTokens).not.toHaveBeenCalled();
    });

    it.each([
      ['another issuer', { issuer: 'https://elsewhere.example' }, { clientId: 'cid' }],
      ['another client', {}, { clientId: 'someone-else' }],
    ])('is revoked and cleared, before the new config is written, for %s', async (_name, change, previous) => {
      h.repo.findByIdWithCredentials.mockResolvedValue(signedIn());
      h.discover.mockResolvedValue(discovery(change));
      h.loadClient.mockResolvedValue(previous);
      await startUserConnectionOAuth(actor, context, 'c1');
      expect(h.revoke).toHaveBeenCalledTimes(1);
      expect(h.repo.clearOAuthTokens).toHaveBeenCalledTimes(1);
      expect(h.repo.clearOAuthTokens.mock.invocationCallOrder[0]).toBeLessThan(
        h.repo.setOAuthConfig.mock.invocationCallOrder[0] ?? 0
      );
    });
  });
});
