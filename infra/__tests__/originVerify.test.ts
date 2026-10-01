/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// infra/*.ts only loads inside `sst`, so these assertions read the sources as text.
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const router = read('infra/router.ts');
const web = read('infra/web.ts');
const proxy = read('apps/client/proxy.ts');

const headerName = (src: string) => src.match(/const ORIGIN_VERIFY_HEADER = '([^']+)'/)?.[1];

describe('origin verification wiring', () => {
  it('uses the same header name in infra/router.ts and apps/client/proxy.ts', () => {
    expect(headerName(router)).toBe('x-b4m-origin-verify');
    expect(headerName(proxy)).toBe(headerName(router));
  });

  it('overwrites any inbound value with the secret in the viewer-request injection', () => {
    const injection = router.match(/const originVerifyInjection = \$interpolate`([\s\S]*?)`;/)?.[1] ?? '';
    expect(injection).toContain(
      'event.request.headers["${ORIGIN_VERIFY_HEADER}"] = { value: "${originVerifySecret.result}" }'
    );
    expect(router).toMatch(/viewerRequest: \{\s*injection: \$interpolate`\$\{originVerifyInjection\}/);
  });

  it('generates an alphanumeric secret so it is safe inside the injected JS string', () => {
    expect(router).toMatch(/new random\.RandomPassword\('OriginVerifySecret', \{[^}]*special: false/);
  });

  it('passes ORIGIN_VERIFY_SECRET to the server only outside sst dev', () => {
    expect(web).toContain('...(!$dev ? { ORIGIN_VERIFY_SECRET: originVerifySecret.result } : {})');
    expect(web.match(/ORIGIN_VERIFY_SECRET/g)).toHaveLength(1);
  });
});
