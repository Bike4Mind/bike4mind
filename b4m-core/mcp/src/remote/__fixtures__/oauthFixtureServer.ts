/**
 * Test-only OAuth fixture for the remote MCP OAuth module: a protected-resource document (RFC 9728), an
 * authorization server (RFC 8414 or OIDC metadata, DCR, authorize, token with rotating refresh tokens,
 * revoke), all on one ephemeral 127.0.0.1 port. Never imported by library code.
 */
import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

export interface OAuthFixtureOptions {
  /** Where the protected-resource document is served; `header` only via the 401 challenge URL. */
  prmLocation?: 'path' | 'root' | 'header';
  metadataStyle?: 'oauth' | 'oidc';
  /** Advertise PKCE S256 (default true). */
  s256?: boolean;
  /** `scopes_supported` in the protected-resource document; the authorization server always lists read and write. */
  prmScopes?: string[];
  /** Name a different resource in the protected-resource document. */
  resourceMismatch?: boolean;
  /** Advertise `client_id_metadata_document_supported`. */
  cimd?: boolean;
  /** Advertise RFC 9207 and send `iss` on the authorization response; `wrong` sends a different one. */
  iss?: boolean | 'wrong';
  /** Lifetime handed out with each access token (default 3600). */
  expiresInSeconds?: number;
  /** Delay every token response, so concurrent callers overlap. */
  tokenDelayMs?: number;
  /** Do not offer registration or a revocation endpoint. */
  noRegistration?: boolean;
  noRevocation?: boolean;
  /** Metadata endpoint URL scheme override, for refusing non-https endpoints. */
  tokenEndpointOverride?: string;
  /**
   * A confidential client that exists at the server and may authenticate ONLY with HTTP Basic (the token and
   * revocation endpoints answer `invalid_client` to anything else). Advertised as the sole auth method unless
   * `omitAuthMethods` is set, which leaves the field out of the metadata.
   */
  basicOnlyClient?: { id: string; secret: string };
  omitAuthMethods?: boolean;
  /** The `token_type` of issued tokens (default `Bearer`). */
  tokenType?: string;
}

export interface OAuthFixtureServer {
  /** Uses the hostname `oauth.test` (the connector URL rules refuse IP literals); `fetch` reaches it on loopback. */
  origin: string;
  /** A fetch that resolves `oauth.test` to the fixture's loopback listener. Pass it as `fetchFn`. */
  fetch: typeof fetch;
  /** The MCP resource URL the connector points at. */
  resourceUrl: string;
  /** The URL a 401 from the resource would carry in `resource_metadata`. */
  resourceMetadataUrl: string;
  /** Token endpoint hits by grant type, plus registrations. */
  counts: { authorizationCode: number; refresh: number; register: number; revoke: number };
  /** Tokens passed to the revocation endpoint, in order. */
  revoked: string[];
  /** Registered clients by id, with the redirect URIs and whether a secret was issued. */
  clients: Map<string, { redirectUris: string[]; secret?: string }>;
  /** The `resource` value each token request carried. */
  tokenResources: (string | null)[];
  /** True when the token is a currently valid access token. */
  isValidAccessToken(token: string): boolean;
  /** Make the next refresh fail with `invalid_grant`. */
  failNextRefresh(): void;
  /**
   * Token requests get a failure (nothing is consumed) until set back to `ok`: `unavailable` an HTML 503,
   * `forbidden` an HTML 403, `invalid_token` a JSON 400 with an error code outside RFC 6749.
   */
  setTokenMode(mode: TokenMode): void;
  /** Mark every issued access token expired (the next use must refresh). */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

type TokenMode =
  | 'ok'
  | 'unavailable'
  | 'forbidden'
  | 'invalid_token'
  | 'rate_limited_html'
  | 'rate_limited_json'
  | 'request_timeout'
  | 'temporarily_unavailable'
  | 'ok_error_bad_refresh_token'
  | 'ok_error_invalid_grant'
  | 'ok_with_error_field';

const sha256b64url = (value: string) => createHash('sha256').update(value).digest('base64url');
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const readForm = async (req: IncomingMessage) => new URLSearchParams(await readText(req));

export async function startOAuthFixtureServer(options: OAuthFixtureOptions = {}): Promise<OAuthFixtureServer> {
  const { prmLocation = 'path', metadataStyle = 'oauth', s256 = true, expiresInSeconds = 3600 } = options;
  const codes = new Map<
    string,
    { challenge: string; clientId: string; redirectUri: string; resource: string | null }
  >();
  const accessTokens = new Map<string, { expired: boolean }>();
  const refreshTokens = new Set<string>();
  const fixture = {
    counts: { authorizationCode: 0, refresh: 0, register: 0, revoke: 0 },
    revoked: [] as string[],
    clients: new Map<string, { redirectUris: string[]; secret?: string }>(),
    tokenResources: [] as (string | null)[],
  };
  let failRefresh = false;
  let tokenMode: TokenMode = 'ok';
  let issued = 0;
  let origin = '';

  const issue = () => {
    issued += 1;
    const accessToken = `at_${issued}_${randomBytes(6).toString('hex')}`;
    const refreshToken = `rt_${issued}_${randomBytes(6).toString('hex')}`;
    accessTokens.set(accessToken, { expired: false });
    refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: options.tokenType ?? 'Bearer',
      expires_in: expiresInSeconds,
      refresh_token: refreshToken,
    };
  };

  const metadata = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: options.tokenEndpointOverride ?? `${origin}/token`,
    ...(options.noRegistration ? {} : { registration_endpoint: `${origin}/register` }),
    ...(options.noRevocation ? {} : { revocation_endpoint: `${origin}/revoke` }),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    ...(options.omitAuthMethods
      ? {}
      : {
          token_endpoint_auth_methods_supported: options.basicOnlyClient
            ? ['client_secret_basic']
            : ['none', 'client_secret_post', 'client_secret_basic'],
        }),
    scopes_supported: ['read', 'write'],
    ...(metadataStyle === 'oidc'
      ? {
          jwks_uri: `${origin}/jwks`,
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }
      : {}),
    ...(s256 ? { code_challenge_methods_supported: ['S256'] } : {}),
    ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
    ...(options.iss ? { authorization_response_iss_parameter_supported: true } : {}),
  });

  /** True when the request satisfies `basicOnlyClient` (or no such client is configured). */
  const clientAuthenticated = (req: IncomingMessage, form: URLSearchParams) => {
    const client = options.basicOnlyClient;
    if (!client) return true;
    if (form.has('client_secret')) return false;
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'basic') return false;
    const [id, secret] = Buffer.from(encoded ?? '', 'base64')
      .toString('utf8')
      .split(':');
    return decodeURIComponent(id ?? '') === client.id && decodeURIComponent(secret ?? '') === client.secret;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;

    if (path === '/.well-known/oauth-protected-resource/mcp' && prmLocation === 'path') {
      return json(res, 200, prm());
    }
    if (path === '/.well-known/oauth-protected-resource' && prmLocation === 'root') return json(res, 200, prm());
    if (path === '/prm-by-header.json' && prmLocation === 'header') return json(res, 200, prm());
    if (path === '/.well-known/oauth-authorization-server' && metadataStyle === 'oauth')
      return json(res, 200, metadata());
    if (path === '/.well-known/openid-configuration' && metadataStyle === 'oidc') return json(res, 200, metadata());

    if (path === '/register' && req.method === 'POST') {
      fixture.counts.register += 1;
      const body = JSON.parse((await readText(req)) || '{}') as {
        redirect_uris: string[];
        token_endpoint_auth_method?: string;
      };
      const clientId = `client_${fixture.clients.size + 1}`;
      const secret = body.token_endpoint_auth_method === 'none' ? undefined : randomBytes(8).toString('hex');
      fixture.clients.set(clientId, { redirectUris: body.redirect_uris, secret });
      return json(res, 201, {
        client_id: clientId,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
      });
    }

    if (path === '/authorize') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = `code_${randomBytes(6).toString('hex')}`;
      codes.set(code, {
        challenge: q.get('code_challenge') ?? '',
        clientId: q.get('client_id') ?? '',
        redirectUri,
        resource: q.get('resource'),
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      if (options.iss) back.searchParams.set('iss', options.iss === 'wrong' ? 'https://evil.example' : origin);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (path === '/token' && req.method === 'POST') {
      const form = await readForm(req);
      if (tokenMode === 'unavailable') {
        res.writeHead(503, { 'content-type': 'text/html' });
        return res.end('<html>Service Unavailable</html>');
      }
      if (tokenMode === 'forbidden') {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<html>Forbidden</html>');
      }
      if (tokenMode === 'invalid_token') return json(res, 400, { error: 'invalid_token' });
      if (tokenMode === 'rate_limited_html') {
        res.writeHead(429, { 'content-type': 'text/html' });
        return res.end('<html>Too Many Requests</html>');
      }
      if (tokenMode === 'rate_limited_json') return json(res, 429, { error: 'invalid_request' });
      if (tokenMode === 'request_timeout') {
        res.writeHead(408, { 'content-type': 'text/html' });
        return res.end('<html>Request Timeout</html>');
      }
      if (tokenMode === 'temporarily_unavailable') return json(res, 400, { error: 'temporarily_unavailable' });
      // Some providers (GitHub) report a failed token request with HTTP 200 and an `error` field.
      if (tokenMode === 'ok_error_bad_refresh_token') return json(res, 200, { error: 'bad_refresh_token' });
      if (tokenMode === 'ok_error_invalid_grant') return json(res, 200, { error: 'invalid_grant' });
      if (!clientAuthenticated(req, form)) return json(res, 401, { error: 'invalid_client' });
      const withErrorField = <T extends object>(body: T) =>
        tokenMode === 'ok_with_error_field' ? { ...body, error: 'x' } : body;
      if (options.tokenDelayMs) await new Promise(resolve => setTimeout(resolve, options.tokenDelayMs));
      fixture.tokenResources.push(form.get('resource'));
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        fixture.counts.authorizationCode += 1;
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (
          !entry ||
          entry.redirectUri !== form.get('redirect_uri') ||
          entry.challenge !== sha256b64url(form.get('code_verifier') ?? '')
        ) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        return json(res, 200, withErrorField(issue()));
      }
      if (grant === 'refresh_token') {
        fixture.counts.refresh += 1;
        const refreshToken = form.get('refresh_token') ?? '';
        if (failRefresh || !refreshTokens.has(refreshToken)) {
          failRefresh = false;
          return json(res, 400, { error: 'invalid_grant' });
        }
        refreshTokens.delete(refreshToken);
        return json(res, 200, withErrorField(issue()));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (path === '/revoke' && req.method === 'POST') {
      const form = await readForm(req);
      if (!clientAuthenticated(req, form)) return json(res, 401, { error: 'invalid_client' });
      fixture.counts.revoke += 1;
      const token = form.get('token') ?? '';
      fixture.revoked.push(token);
      accessTokens.delete(token);
      refreshTokens.delete(token);
      res.writeHead(200);
      return res.end();
    }
    json(res, 404, { error: 'not_found' });
  };

  const prm = () => ({
    resource: options.resourceMismatch ? 'https://other.example/mcp' : `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    ...(options.prmScopes && { scopes_supported: options.prmScopes }),
  });

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://oauth.test:${port}`;
  const loopbackFetch = ((input: string | URL, init?: RequestInit) => {
    const target = new URL(input.toString());
    if (target.hostname === 'oauth.test') target.hostname = '127.0.0.1';
    return fetch(target, init);
  }) as typeof fetch;

  return {
    origin,
    fetch: loopbackFetch,
    resourceUrl: `${origin}/mcp`,
    resourceMetadataUrl: `${origin}/prm-by-header.json`,
    counts: fixture.counts,
    revoked: fixture.revoked,
    clients: fixture.clients,
    tokenResources: fixture.tokenResources,
    isValidAccessToken: token => accessTokens.get(token)?.expired === false,
    failNextRefresh: () => {
      failRefresh = true;
    },
    setTokenMode: mode => {
      tokenMode = mode;
    },
    expireAccessTokens: () => accessTokens.forEach(entry => (entry.expired = true)),
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
