/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { minifyRouterFunction, noindexResponseInjection } from '../routerFunctionCode';

// infra/router.ts only loads inside `sst`, so wiring is asserted against its source text.
const router = readFileSync(new URL('../router.ts', import.meta.url), 'utf8');

const run = (stage: string, headers: Record<string, { value: string }> = {}) => {
  const code = minifyRouterFunction(
    `(function(event) { ${noindexResponseInjection(stage)}; return event.response; })(event)`
  );
  return runInNewContext(code, {
    event: { response: { headers: { 'cache-control': { value: 'no-store' }, ...headers } } },
  });
};

describe('router noindex injection', () => {
  it('adds nothing on production', () => {
    expect(noindexResponseInjection('production')).toBe('');
    expect(run('production').headers['x-robots-tag']).toBeUndefined();
  });

  it.each(['dev', 'pr1234', 'shared-dev', 'someone'])('sets x-robots-tag noindex, nofollow on stage %s', stage => {
    expect(run(stage).headers['x-robots-tag']).toEqual({ value: 'noindex, nofollow' });
  });

  it('replaces an origin indexing opt-in on non-production stages', () => {
    expect(run('dev', { 'x-robots-tag': { value: 'index, follow' } }).headers['x-robots-tag']).toEqual({
      value: 'noindex, nofollow',
    });
  });

  it('preserves the origin indexing policy on production', () => {
    expect(run('production', { 'x-robots-tag': { value: 'index, follow' } }).headers['x-robots-tag']).toEqual({
      value: 'index, follow',
    });
  });

  it('leaves other response headers alone', () => {
    expect(run('dev').headers['cache-control']).toEqual({ value: 'no-store' });
  });

  it('is wired into the viewer-response function with the deployed stage', () => {
    expect(router).toMatch(
      /viewerResponse: \{\s*injection:\s*userFileCspInjection \+ noindexResponseInjection\(\$app\.stage\)/
    );
  });
});
