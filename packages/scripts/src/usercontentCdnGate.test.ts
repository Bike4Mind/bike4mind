import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, it } from 'vitest';
import { allowsUsercontentRequest } from '../../server-utils/src/utils/usercontentRequest';
import { minifyRouterFunction } from '../../../infra/routerFunctionCode';

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
    runInNewContext(minifyRouterFunction(`(function(event) { ${injection}; return event.request; })(event)`), {
      event: { request: { headers: { host: { value: 'pub1.usercontent.app.example.com' } }, uri, method: 'GET' } },
    });
  for (const path of ['/login', '/api/auth/login', '/_next/image', '/profile-photos/test.svg']) {
    expect(execute(path).statusCode).toBe(404);
  }
  expect(execute('/uc/u/user/page').uri).toBe('/uc/u/user/page');
});

it('minifies the routing code while preserving the CloudFront entry point and module import', () => {
  const code = `import cf from 'cloudfront';
    async function handler(event) {
      // ${'padding '.repeat(1500)}
      return cf.kvs().get(event.request.uri);
    }`;
  expect(Buffer.byteLength(code)).toBeGreaterThan(10_240);
  const minified = minifyRouterFunction(code);
  expect(minified).toContain('async function handler(event)');
  expect(minified).toContain('from"cloudfront"');
  expect(minified).toContain('cf.kvs().get(event.request.uri)');
  expect(Buffer.byteLength(minified)).toBeLessThan(10_240);
  const router = readFileSync(new URL('../../../infra/router.ts', import.meta.url), 'utf8');
  expect(router).toContain("if (name !== 'RouterCloudfrontFunctionRequest') return;");
  expect(router).toContain('args.code = $output(args.code).apply(prepareRouterRequestFunction)');
});

it('rejects routing code that still exceeds the CloudFront byte limit after minification', () => {
  expect(() => minifyRouterFunction(`function handler(){return "${'x'.repeat(10_240)}";}`)).toThrow(/maximum is 10240/);
});

it('retains SST runtime syntax instead of introducing newer syntax during minification', () => {
  const sstCode = transformSync(
    `function handler(event) {
      let override = event.request.origin;
      override = override ?? {};
      try { return override?.domainName || event.request.uri; }
      catch (error) { return 'failed'; }
    }`,
    { minifyWhitespace: true, minifySyntax: true, target: 'es2018' }
  ).code;
  const minified = minifyRouterFunction(sstCode);
  expect(minified).not.toMatch(/\?\?|\?\.|catch\s*\{/);
  expect(runInNewContext(`${minified}; handler({request: {uri: '/login'}})`)).toBe('/login');
  expect(runInNewContext(`${minified}; handler({request: {origin: {domainName: 'origin.example.com'}}})`)).toBe(
    'origin.example.com'
  );
});
