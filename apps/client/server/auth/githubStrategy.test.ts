import { describe, expect, it } from 'vitest';
import { isProviderEmailVerified, selectProviderEmail } from '@server/utils/auth/oauthAccountLink';
import { createGitHubStrategy } from './githubStrategy';

interface SentRequest {
  path: string;
  headers: Record<string, string>;
}

type ExecuteCallback = (err: unknown, body?: string, res?: unknown) => void;

const TOKEN = 'gho_test_token';

// Stands in for api.github.com: like the real API, it ignores ?access_token= and
// only authenticates a token sent in the Authorization header.
function buildStrategyAgainstFakeGitHub() {
  const strategy = createGitHubStrategy(
    {
      clientID: 'client-id',
      clientSecret: 'client-secret',
      callbackURL: 'https://app.example.test/api/auth/github/callback',
      scope: ['user:email'],
    },
    () => {}
  );
  const sent: SentRequest[] = [];
  const oauth2 = (strategy as unknown as { _oauth2: Record<string, unknown> })._oauth2;
  oauth2._executeRequest = (
    _lib: unknown,
    options: { path: string; headers: Record<string, string> },
    _body: unknown,
    callback: ExecuteCallback
  ) => {
    sent.push({ path: options.path, headers: options.headers });
    if (options.headers.Authorization !== `Bearer ${TOKEN}`) {
      return callback({ statusCode: 401, data: '{"message":"Requires authentication"}' });
    }
    if (options.path.startsWith('/user/emails')) {
      return callback(
        null,
        JSON.stringify([
          { email: 'octo@users.noreply.github.com', primary: false, verified: true },
          { email: 'octo@example.com', primary: true, verified: true },
        ]),
        { statusCode: 200 }
      );
    }
    return callback(null, JSON.stringify({ id: 42, login: 'octo', name: 'Octo Cat', email: null }), {
      statusCode: 200,
    });
  };
  const loadProfile = () =>
    new Promise<unknown>((resolve, reject) =>
      strategy.userProfile(TOKEN, (err: unknown, profile?: unknown) => (err ? reject(err) : resolve(profile)))
    );
  return { sent, loadProfile };
}

describe('createGitHubStrategy', () => {
  it("GitHub sign-in requests the user's emails with the token in the Authorization header", async () => {
    const { sent, loadProfile } = buildStrategyAgainstFakeGitHub();

    await loadProfile();

    const emailsRequest = sent.find(r => r.path.startsWith('/user/emails'));
    expect(emailsRequest).toBeDefined();
    expect(emailsRequest!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(emailsRequest!.path).not.toContain('access_token');
    for (const r of sent) expect(r.path).not.toContain(TOKEN);
  });

  it('a GitHub profile with a private verified primary email signs up with that email', async () => {
    const { loadProfile } = buildStrategyAgainstFakeGitHub();

    const profile = await loadProfile();

    expect(selectProviderEmail(profile)?.value).toBe('octo@example.com');
    expect(isProviderEmailVerified(profile)).toBe(true);
  });
});
