/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'node:vm';
import { CLOUDFRONT_VIEWER_JA4_HEADER } from '../../packages/server-utils/src/utils/trustedClientIpHeaders';
import { AUTH_NETWORK_PATHS, authNetworkJa4Injection } from '../authNetworkForwarding';

// infra/*.ts only loads inside `sst`, so these assertions read the sources as text.
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const router = read('infra/router.ts');
const web = read('infra/web.ts');
const proxy = read('apps/client/proxy.ts');

const headerName = (src: string) => src.match(/const ORIGIN_VERIFY_HEADER = '([^']+)'/)?.[1];

describe('origin verification wiring', () => {
  it.each<[uri: string, preserve: boolean]>([
    ['', false],
    ['/login', false],
    ['/api/test/create-user', false],
    ['/api/authentic/verify', false],
    ['/api/auth', false],
    ['/API/auth/verify', false],
    ['/api/auth/../test/create-user', false],
    ['/api/auth/%2e%2e/test/create-user', false],
    ['/api/auth/..%2ftest/create-user', false],
    ['/api/auth/\\test/create-user', false],
    ...AUTH_NETWORK_PATHS.map((path): [string, boolean] => [path.replace('*', 'verify'), true]),
  ])('preserves only trusted auth-path JA4 before stamping origin verification: %s', (uri, preserve) => {
    const template = router.match(/const originVerifyInjection = \$interpolate`([\s\S]*?)`;/)?.[1];
    expect(template).toBeTruthy();
    const injection = template!
      .replace('${ORIGIN_VERIFY_HEADER}', 'x-b4m-origin-verify')
      .replace('${originVerifySecret.result}', 'synthetic-secret')
      .replace('${authNetworkJa4Injection}', authNetworkJa4Injection);
    const headers = {
      [CLOUDFRONT_VIEWER_JA4_HEADER]: { value: 't13d0101h2_111111111111_222222222222' },
      'x-b4m-origin-verify': { value: 'forged-secret' },
      'user-agent': { value: 'synthetic-client' },
    };
    runInNewContext(injection, { event: { request: { headers, uri } } });
    if (preserve) {
      expect(headers[CLOUDFRONT_VIEWER_JA4_HEADER].value).toBe('t13d0101h2_111111111111_222222222222');
    } else {
      expect(headers).not.toHaveProperty(CLOUDFRONT_VIEWER_JA4_HEADER);
    }
    expect(headers['x-b4m-origin-verify'].value).toBe('synthetic-secret');
    expect(headers['user-agent'].value).toBe('synthetic-client');
  });

  it('uses the same header name in infra/router.ts and apps/client/proxy.ts', () => {
    expect(headerName(router)).toBe('x-b4m-origin-verify');
    expect(headerName(proxy)).toBe(headerName(router));
  });

  it('overwrites any inbound value with the secret in the viewer-request injection', () => {
    const injection = router.match(/const originVerifyInjection = \$interpolate`([\s\S]*?)`;/)?.[1] ?? '';
    expect(injection).toContain(
      'event.request.headers["${ORIGIN_VERIFY_HEADER}"] = { value: "${originVerifySecret.result}" }'
    );
    expect(router).toMatch(
      /viewerRequest: \{\s*injection: \$interpolate`\$\{usercontentGateInjection\}\$\{originVerifyInjection\}\$\{userFileMarkerInjection\}`/
    );
  });

  it('generates an alphanumeric secret so it is safe inside the injected JS string', () => {
    expect(router).toMatch(/new random\.RandomPassword\('OriginVerifySecret', \{[^}]*special: false/);
  });

  it('passes ORIGIN_VERIFY_SECRET to the server only outside sst dev and unless disabled', () => {
    expect(web).toMatch(
      /\.\.\.\(!\$dev && process\.env\.DISABLE_ORIGIN_VERIFY !== 'true'\s*\? \{ ORIGIN_VERIFY_SECRET: originVerifySecret\.result \}\s*: \{\}\)/
    );
    expect(web.match(/ORIGIN_VERIFY_SECRET/g)).toHaveLength(1);
  });
});
