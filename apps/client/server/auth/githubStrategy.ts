import { Strategy as GitHubStrategy } from 'passport-github';

type RequestCallback = (err: unknown, body?: string, res?: unknown) => void;

/** The slice of node-oauth's OAuth2 client (oauth/lib/oauth2.js) this module patches. */
interface NodeOAuth2Client {
  _request(
    method: string,
    url: string,
    headers: Record<string, string> | null | undefined,
    postBody: string | null,
    accessToken: string | null | undefined,
    callback: RequestCallback
  ): void;
  buildAuthHeader(token: string): string;
}

/**
 * Make every token-bearing request on a node-oauth client send the token as
 * `Authorization: Bearer`. node-oauth otherwise appends `?access_token=`, which
 * GitHub rejects. `useAuthorizationHeaderforGET(true)` (set by passport-github)
 * only covers `OAuth2.get()`; passport-github fetches /user/emails through
 * `_request()` directly, so without this the call 401s, the library swallows
 * the error, and the profile reaches verifyCallback with no emails.
 */
export function sendTokenInAuthorizationHeader(client: NodeOAuth2Client): void {
  const request = client._request.bind(client);
  client._request = (method, url, headers, postBody, accessToken, callback) => {
    if (!accessToken || (headers && 'Authorization' in headers)) {
      return request(method, url, headers, postBody, accessToken, callback);
    }
    return request(
      method,
      url,
      { ...headers, Authorization: client.buildAuthHeader(accessToken) },
      postBody,
      null,
      callback
    );
  };
}

/** Build the passport-github strategy with GitHub-compatible token transport. */
export function createGitHubStrategy(
  options: Record<string, unknown>,
  // any: matches passport's untyped variadic verify signature
  verify: (...args: any[]) => void
): GitHubStrategy {
  // tsgo (TypeScript 7.0 RC) only resolves the FINAL constructor overload of
  // passport-github's Strategy - a known divergence for `export =` classes that
  // extend another class - so it wrongly demands the passReqToCallback:true
  // signature and rejects this valid StrategyOptions call. Classic tsc resolves
  // the overloads correctly. Cast around the RC's faulty overload resolution;
  // runtime is unchanged (passReqToCallback defaults to false, so verify receives
  // (accessToken, refreshToken, profile, done)). See typecheck-report.md.
  const strategy = new (
    GitHubStrategy as unknown as new (
      options: Record<string, unknown>,
      verify: (...args: any[]) => void
    ) => GitHubStrategy
  )(options, verify);
  sendTokenInAuthorizationHeader((strategy as unknown as { _oauth2: NodeOAuth2Client })._oauth2);
  return strategy;
}
