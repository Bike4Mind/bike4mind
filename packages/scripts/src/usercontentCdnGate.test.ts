import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { allowsUsercontentRequest } from '../../server-utils/src/utils/usercontentRequest';

it('executes the deployed CDN gate before routing and cache lookup', () => {
  const router = readFileSync(new URL('../../../infra/router.ts', import.meta.url), 'utf8');
  const template = router.match(/const usercontentGateInjection = `([\s\S]*?)`;/)?.[1];
  expect(template).toBeTruthy();
  expect(router).toContain(
    'injection: $interpolate`${usercontentGateInjection}${originVerifyInjection}${userFileMarkerInjection}`'
  );
  const injection = template!
    .replace('${allowsUsercontentRequest.toString()}', allowsUsercontentRequest.toString())
    .replace("${JSON.stringify(domain ?? '')}", JSON.stringify('example.com'));
  const execute = (uri: string) =>
    runInNewContext(`(function(event) { ${injection}; return event.request; })(event)`, {
      event: { request: { headers: { host: { value: 'pub1.usercontent.app.example.com' } }, uri, method: 'GET' } },
    });
  for (const path of ['/login', '/api/auth/login', '/_next/image', '/profile-photos/test.svg']) {
    expect(execute(path).statusCode).toBe(404);
  }
  expect(execute('/uc/u/user/page').uri).toBe('/uc/u/user/page');
});
