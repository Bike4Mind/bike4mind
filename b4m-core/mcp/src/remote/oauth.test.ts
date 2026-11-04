import { afterEach, describe, expect, it } from 'vitest';
import {
  RemoteMcpInvalidGrantError,
  buildRemoteMcpAuthorizationUrl,
  discoverRemoteMcpOAuth,
  exchangeRemoteMcpCode,
  refreshRemoteMcpTokens,
  registerRemoteMcpClient,
  revokeRemoteMcpToken,
} from './oauth';
import {
  startOAuthFixtureServer,
  type OAuthFixtureOptions,
  type OAuthFixtureServer,
} from './__fixtures__/oauthFixtureServer';

const network = { allowHttp: true };
const redirectUri = 'https://app.example/integrations/mcp-oauth-callback';

let fixture: OAuthFixtureServer | undefined;
async function start(options?: OAuthFixtureOptions) {
  fixture = await startOAuthFixtureServer(options);
  return fixture;
}
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const discover = (f: OAuthFixtureServer, resourceMetadataUrl?: string) =>
  discoverRemoteMcpOAuth(f.resourceUrl, { resourceMetadataUrl, fetchFn: f.fetch, network });

describe('discoverRemoteMcpOAuth', () => {
  it.each([
    ['well-known path', { prmLocation: 'path' as const }, false],
    ['root well-known', { prmLocation: 'root' as const }, false],
    ['challenge header URL', { prmLocation: 'header' as const }, true],
  ])('finds the authorization server through the %s', async (_name, options, useHeader) => {
    const f = await start(options);
    const found = await discover(f, useHeader ? f.resourceMetadataUrl : undefined);
    expect(found).toMatchObject({
      resource: f.resourceUrl,
      issuer: f.origin,
      tokenEndpoint: `${f.origin}/token`,
      revocationEndpoint: `${f.origin}/revoke`,
      registrationEndpoint: `${f.origin}/register`,
      scopesSupported: ['read', 'write'],
      issParameterSupported: false,
    });
  });

  it('reads OIDC metadata when RFC 8414 metadata is absent', async () => {
    const f = await start({ metadataStyle: 'oidc', cimd: true });
    expect(await discover(f)).toMatchObject({ tokenEndpoint: `${f.origin}/token`, cimdSupported: true });
  });

  it('refuses a resource that names a different server', async () => {
    const f = await start({ resourceMismatch: true });
    await expect(discover(f)).rejects.toMatchObject({
      code: 'discovery_failed',
      message: expect.stringContaining('different resource'),
    });
  });

  it('refuses an authorization server that does not support S256', async () => {
    const f = await start({ s256: false });
    await expect(discover(f)).rejects.toThrow(/S256/);
  });

  it('refuses a metadata endpoint that is not https unless plain http is allowed', async () => {
    const f = await start();
    await expect(discoverRemoteMcpOAuth(f.resourceUrl, { fetchFn: f.fetch, network: {} })).rejects.toThrow();
  });

  it('refuses a token endpoint on a private address', async () => {
    const f = await start({ tokenEndpointOverride: 'https://169.254.169.254/token' });
    await expect(discover(f)).rejects.toThrow(/token endpoint is not allowed/);
  });
});

describe('sign-in, refresh and revoke against the fixture', () => {
  async function signIn(f: OAuthFixtureServer) {
    const discovery = await discover(f);
    const client = await registerRemoteMcpClient(discovery, { redirectUri, clientName: 'Test', fetchFn: f.fetch });
    const { authorizationUrl, codeVerifier } = await buildRemoteMcpAuthorizationUrl(discovery, {
      client,
      redirectUri,
      state: 'state-1',
      scopes: ['read'],
    });
    const response = await f.fetch(authorizationUrl, { redirect: 'manual' });
    const back = new URL(response.headers.get('location') ?? '');
    const tokens = await exchangeRemoteMcpCode(discovery, {
      client,
      code: back.searchParams.get('code') ?? '',
      codeVerifier,
      redirectUri,
      fetchFn: f.fetch,
    });
    return { discovery, client, authorizationUrl: new URL(authorizationUrl), back, tokens };
  }

  it('builds an S256 authorization URL carrying resource and state, and exchanges the code with the resource', async () => {
    const f = await start();
    const { authorizationUrl, back, tokens } = await signIn(f);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(f.resourceUrl);
    expect(authorizationUrl.searchParams.get('state')).toBe('state-1');
    expect(authorizationUrl.searchParams.get('scope')).toBe('read');
    expect(back.searchParams.get('state')).toBe('state-1');
    expect(f.isValidAccessToken(tokens.accessToken)).toBe(true);
    expect(f.tokenResources).toEqual([f.resourceUrl]);
  });

  it('rotates the refresh token and sends the resource on refresh', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signIn(f);
    const refreshed = await refreshRemoteMcpTokens(discovery, {
      client,
      refreshToken: tokens.refreshToken ?? '',
      fetchFn: f.fetch,
    });
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
    expect(f.tokenResources).toEqual([f.resourceUrl, f.resourceUrl]);
  });

  it('maps a rejected refresh token to invalid_grant', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signIn(f);
    await refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch });
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).rejects.toBeInstanceOf(RemoteMcpInvalidGrantError);
  });

  it('revokes both tokens at the revocation endpoint', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signIn(f);
    for (const [token, hint] of [
      [tokens.refreshToken ?? '', 'refresh_token'],
      [tokens.accessToken, 'access_token'],
    ] as const) {
      await revokeRemoteMcpToken(discovery.revocationEndpoint ?? '', { token, hint, client, fetchFn: f.fetch });
    }
    expect(f.revoked).toEqual([tokens.refreshToken, tokens.accessToken]);
    expect(f.isValidAccessToken(tokens.accessToken)).toBe(false);
  });

  it('rejects a replayed authorization code', async () => {
    const f = await start();
    const { discovery, client, back } = await signIn(f);
    await expect(
      exchangeRemoteMcpCode(discovery, {
        client,
        code: back.searchParams.get('code') ?? '',
        codeVerifier: 'x'.repeat(43),
        redirectUri,
        fetchFn: f.fetch,
      })
    ).rejects.toBeInstanceOf(RemoteMcpInvalidGrantError);
  });
});
