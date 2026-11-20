import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteMcpInvalidGrantError,
  buildRemoteMcpAuthorizationUrl,
  chooseClientAuthMethod,
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
    const f = await start({ ...options, prmScopes: ['read', 'write'] });
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

  it('takes default scopes from the protected resource, never the authorization server', async () => {
    const f = await start();
    expect((await discover(f)).scopesSupported).toEqual([]);
  });

  it('keeps the revocation endpoint and the RFC 9207 flag on the OIDC-only path', async () => {
    const f = await start({ metadataStyle: 'oidc', iss: true });
    expect(await discover(f)).toMatchObject({
      revocationEndpoint: `${f.origin}/revoke`,
      issParameterSupported: true,
    });
  });

  it('ignores a raw metadata document whose issuer differs from the validated one', async () => {
    const f = await start({ metadataStyle: 'oidc' });
    const decoyPath = '/.well-known/oauth-authorization-server';
    let hits = 0;
    const fetchFn = ((input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === decoyPath && (hits += 1) > 1) {
        return Promise.resolve(
          Response.json({ issuer: 'https://other.example', revocation_endpoint: 'https://decoy.example/revoke' })
        );
      }
      return f.fetch(input, init);
    }) as typeof fetch;
    const found = await discoverRemoteMcpOAuth(f.resourceUrl, { fetchFn, network });
    expect(hits).toBeGreaterThan(1);
    expect(found.revocationEndpoint).toBe(`${f.origin}/revoke`);
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

  it('refuses a server URL that is not https unless plain http is allowed', async () => {
    const f = await start();
    await expect(discoverRemoteMcpOAuth(f.resourceUrl, { fetchFn: f.fetch, network: {} })).rejects.toThrow();
  });

  describe('against a stubbed https server', () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    function stub(overrides: { issuer?: string; tokenEndpoint?: string } = {}) {
      const requested: string[] = [];
      const fetchFn = vi.fn(async (input: string | URL) => {
        const url = input.toString();
        requested.push(url);
        if (url === 'https://mcp.example/.well-known/oauth-protected-resource/mcp') {
          return json({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://as.example'] });
        }
        if (url === 'https://as.example/.well-known/oauth-authorization-server') {
          return json({
            issuer: overrides.issuer ?? 'https://as.example',
            authorization_endpoint: 'https://as.example/authorize',
            token_endpoint: overrides.tokenEndpoint ?? 'https://as.example/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          });
        }
        return new Response('not found', { status: 404 });
      });
      return { fetchFn: fetchFn as unknown as typeof fetch, requested };
    }
    const run = (s: ReturnType<typeof stub>, resourceMetadataUrl?: string) =>
      discoverRemoteMcpOAuth('https://mcp.example/mcp', { resourceMetadataUrl, fetchFn: s.fetchFn, network: {} });

    it('accepts a well-formed https server', async () => {
      expect(await run(stub())).toMatchObject({ tokenEndpoint: 'https://as.example/token' });
    });

    it('refuses an http token endpoint with the endpoint message', async () => {
      await expect(run(stub({ tokenEndpoint: 'http://as.example/token' }))).rejects.toMatchObject({
        code: 'discovery_failed',
        message: expect.stringMatching(/token endpoint is not allowed/),
      });
    });

    it('refuses metadata whose issuer is not the authorization server', async () => {
      await expect(run(stub({ issuer: 'https://other.example' }))).rejects.toMatchObject({
        code: 'discovery_failed',
        message: expect.stringContaining('issuer does not match'),
      });
    });

    it('never fetches a challenge resource_metadata URL on a private address', async () => {
      const s = stub();
      const found = await run(s, 'https://169.254.169.254/prm.json');
      expect(s.requested.some(url => url.includes('169.254.169.254'))).toBe(false);
      expect(found.issuer).toBe('https://as.example');
    });
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

describe('token endpoint failures', () => {
  async function signedIn(f: OAuthFixtureServer) {
    const discovery = await discover(f);
    const client = await registerRemoteMcpClient(discovery, { redirectUri, clientName: 'Test', fetchFn: f.fetch });
    const { authorizationUrl, codeVerifier } = await buildRemoteMcpAuthorizationUrl(discovery, {
      client,
      redirectUri,
      state: 's',
      scopes: [],
    });
    const back = new URL((await f.fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location') ?? '');
    const code = back.searchParams.get('code') ?? '';
    const tokens = await exchangeRemoteMcpCode(discovery, {
      client,
      code,
      codeVerifier,
      redirectUri,
      fetchFn: f.fetch,
    });
    return { discovery, client, tokens, code, codeVerifier };
  }

  it('reports a 503 on refresh as unavailable, not as a refused grant', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    f.setTokenMode('unavailable');
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).rejects.toMatchObject({ code: 'token_unavailable' });
  });

  it('reports a 503 on the code exchange as unavailable', async () => {
    const f = await start();
    const { discovery, client, code, codeVerifier } = await signedIn(f);
    f.setTokenMode('unavailable');
    await expect(
      exchangeRemoteMcpCode(discovery, { client, code, codeVerifier, redirectUri, fetchFn: f.fetch })
    ).rejects.toMatchObject({ code: 'token_unavailable' });
  });

  it.each([
    ['an HTML 403', 'forbidden'],
    ['a JSON invalid_token 400', 'invalid_token'],
  ] as const)('reports %s on refresh as a refused request, not an outage', async (_name, mode) => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    f.setTokenMode(mode);
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).rejects.toMatchObject({ code: 'token_failed' });
  });

  it.each([
    ['an HTML 429', 'rate_limited_html'],
    ['a JSON 429', 'rate_limited_json'],
    ['an HTML 408', 'request_timeout'],
    ['a JSON temporarily_unavailable 400', 'temporarily_unavailable'],
  ] as const)('reports %s on refresh as an outage, not a refused grant', async (_name, mode) => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    f.setTokenMode(mode);
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).rejects.toMatchObject({ code: 'token_unavailable' });
  });

  it('reports a 200 with an error body as the error it carries', async () => {
    const f = await start();
    const { discovery, client, tokens, code, codeVerifier } = await signedIn(f);
    f.setTokenMode('ok_error_bad_refresh_token');
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).rejects.toMatchObject({ code: 'token_failed' });
    await expect(
      exchangeRemoteMcpCode(discovery, { client, code, codeVerifier, redirectUri, fetchFn: f.fetch })
    ).rejects.toMatchObject({ code: 'token_failed' });
    f.setTokenMode('ok_error_invalid_grant');
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).rejects.toBeInstanceOf(RemoteMcpInvalidGrantError);
    f.setTokenMode('ok');
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it('still succeeds on a 200 that carries a token alongside an error field', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    f.setTokenMode('ok_with_error_field');
    await expect(
      refreshRemoteMcpTokens(discovery, { client, refreshToken: tokens.refreshToken ?? '', fetchFn: f.fetch })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it('classifies a pinned-fetch timeout as unavailable and any other blocked request as refused', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    const pinned = (code: string) => Object.assign(new Error(code), { name: 'PinnedFetchError', code });
    for (const [code, expected] of [
      ['timeout', 'token_unavailable'],
      ['ssrf_blocked', 'token_failed'],
      ['size_cap', 'token_unavailable'],
    ] as const) {
      await expect(
        refreshRemoteMcpTokens(discovery, {
          client,
          refreshToken: tokens.refreshToken ?? '',
          fetchFn: (() => Promise.reject(pinned(code))) as unknown as typeof fetch,
        })
      ).rejects.toMatchObject({ code: expected });
    }
  });

  it('keeps an oversized 5xx body an outage but an oversized 4xx a refusal', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    const oversized = (status: number) =>
      (async () => {
        const body = new ReadableStream({
          start: controller =>
            controller.error(Object.assign(new Error('size_cap'), { name: 'PinnedFetchError', code: 'size_cap' })),
        });
        return new Response(body, { status });
      }) as unknown as typeof fetch;
    for (const [status, expected] of [
      [503, 'token_unavailable'],
      [403, 'token_failed'],
    ] as const) {
      await expect(
        refreshRemoteMcpTokens(discovery, {
          client,
          refreshToken: tokens.refreshToken ?? '',
          fetchFn: oversized(status),
        })
      ).rejects.toMatchObject({ code: expected });
    }
  });

  it.each([
    ['a schema-invalid 200', 200],
    ['a 302', 302],
  ])('reports %s from the token endpoint as token_failed', async (_name, status) => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    await expect(
      refreshRemoteMcpTokens(discovery, {
        client,
        refreshToken: tokens.refreshToken ?? '',
        fetchFn: (async () =>
          new Response(status === 200 ? '{}' : '', {
            status,
            headers: status === 200 ? { 'content-type': 'application/json' } : { location: 'https://other.example/' },
          })) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'token_failed' });
  });

  it('reports a network error and a timeout as unavailable', async () => {
    const f = await start();
    const { discovery, client, tokens } = await signedIn(f);
    for (const error of [new TypeError('fetch failed'), new Error('Request timed out')]) {
      await expect(
        refreshRemoteMcpTokens(discovery, {
          client,
          refreshToken: tokens.refreshToken ?? '',
          fetchFn: (() => Promise.reject(error)) as unknown as typeof fetch,
        })
      ).rejects.toMatchObject({ code: 'token_unavailable' });
    }
  });

  it('reports a definitive refusal (invalid_client) as token_failed', async () => {
    const f = await start({ basicOnlyClient: { id: 'c', secret: 's' } });
    const discovery = await discover(f);
    await expect(
      refreshRemoteMcpTokens(discovery, {
        client: { clientId: 'c', clientSecret: 'wrong', tokenEndpointAuthMethod: 'client_secret_basic' },
        refreshToken: 'x',
        fetchFn: f.fetch,
      })
    ).rejects.toMatchObject({ code: 'token_failed' });
  });

  it('refuses a token that is not a bearer token', async () => {
    const f = await start({ tokenType: 'mac' });
    await expect(signedIn(f)).rejects.toMatchObject({
      code: 'token_failed',
      message: expect.stringContaining('not a bearer token'),
    });
  });
});

describe('token endpoint authentication method', () => {
  it.each([
    [[], true, 'client_secret_basic'],
    [['client_secret_basic', 'client_secret_post'], true, 'client_secret_basic'],
    [['client_secret_post'], true, 'client_secret_post'],
    [['private_key_jwt'], true, 'client_secret_basic'],
    [['client_secret_post'], false, 'none'],
  ])('chooses from %j (secret: %s) -> %s', (supported, hasSecret, expected) => {
    expect(chooseClientAuthMethod(supported, hasSecret)).toBe(expected);
  });

  it.each([
    ['advertised', {}],
    ['not advertised', { omitAuthMethods: true }],
  ])('a basic-only server signs in, refreshes and revokes a manual client (%s)', async (_name, extra) => {
    const f = await start({ basicOnlyClient: { id: 'my client', secret: 's3cret/+=' }, ...extra });
    const discovery = await discover(f);
    const client = {
      clientId: 'my client',
      clientSecret: 's3cret/+=',
      tokenEndpointAuthMethod: chooseClientAuthMethod(discovery.tokenEndpointAuthMethodsSupported, true),
    };
    const { authorizationUrl, codeVerifier } = await buildRemoteMcpAuthorizationUrl(discovery, {
      client,
      redirectUri,
      state: 's',
      scopes: [],
    });
    const back = new URL((await f.fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location') ?? '');
    const tokens = await exchangeRemoteMcpCode(discovery, {
      client,
      code: back.searchParams.get('code') ?? '',
      codeVerifier,
      redirectUri,
      fetchFn: f.fetch,
    });
    const refreshed = await refreshRemoteMcpTokens(discovery, {
      client,
      refreshToken: tokens.refreshToken ?? '',
      fetchFn: f.fetch,
    });
    await revokeRemoteMcpToken(discovery.revocationEndpoint ?? '', {
      token: refreshed.refreshToken ?? '',
      hint: 'refresh_token',
      client,
      fetchFn: f.fetch,
    });
    expect(f.revoked).toEqual([refreshed.refreshToken]);
  });

  it('client_secret_post is refused by a basic-only server', async () => {
    const f = await start({ basicOnlyClient: { id: 'c', secret: 's' } });
    const discovery = await discover(f);
    await expect(
      refreshRemoteMcpTokens(discovery, {
        client: { clientId: 'c', clientSecret: 's', tokenEndpointAuthMethod: 'client_secret_post' },
        refreshToken: 'x',
        fetchFn: f.fetch,
      })
    ).rejects.toMatchObject({ code: 'token_failed' });
  });
});
