import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Inventory of the unauthenticated entry points that opt into the IP-block gate themselves (every
 * authenticated route gets it from baseApi; see baseApi.ipBlock.test.ts, and the ChatCompletion
 * service and WebSocket $connect have their own tests). A sign-in or sign-up route checks the
 * `login` surface, which honours lockouts and `all` blocks alike, so an `all` block stops signup by
 * every provider; an anonymous AI entry point checks the `app` surface.
 */

const API_ROOT = resolve(__dirname, '../../pages/api');
const source = (route: string) => readFileSync(resolve(API_ROOT, route), 'utf8');

const LOGIN_ROUTES = [
  'auth/strategy.ts',
  'auth/[strategy]/index.ts',
  'auth/[strategy]/callback.ts',
  'auth/okta/index.ts',
  'auth/okta/callback.ts',
  'auth/saml/index.ts',
  'auth/saml/callback.ts',
  'auth/refreshToken.ts',
  'auth/returnToAdmin.ts',
  'otc/send.ts',
  'otc/verify.ts',
  'subscribers/create.ts',
  'admin/emergency-login.ts',
];

const ANONYMOUS_APP_ROUTES: ReadonlyArray<[string, string]> = [
  ['embed/session.ts', "checkBlockedIP({ surface: 'app', writesOnly: true })"],
  ['voice/v2/llm-proxy/chat/completions.ts', "checkBlockedIP({ surface: 'app' })"],
];

describe('IP-block gate on unauthenticated entry points', () => {
  it.each(LOGIN_ROUTES)('%s checks the login surface', route => {
    expect(source(route)).toMatch(/\.use\(checkBlockedIP\(\)\)/);
  });

  it.each(ANONYMOUS_APP_ROUTES)('%s checks the app surface', (route, call) => {
    expect(source(route)).toContain(`.use(${call})`);
  });
});
