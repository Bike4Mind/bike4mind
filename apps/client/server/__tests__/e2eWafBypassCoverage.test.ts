// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

// Calls that reach the stage origin must carry the WAF bypass header, or the edge rate rules can
// block an e2e run. waf-test.ts covers the `context` and `request` fixtures; this guard flags the
// shapes that bypass them (below). Selfhost specs run against no stage.
const E2E_DIR = path.join(__dirname, '..', '..', 'e2e');

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function importsRuntimeTest(source: string): boolean {
  const imports = source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*'@playwright\/test'/g);
  for (const [, typeOnly, specifiers] of imports) {
    if (typeOnly) continue;
    if (specifiers.split(',').some(s => /^test(\s+as\s+\w+)?$/.test(s.trim()))) return true;
  }
  return false;
}

// A page's or context's own .request and route.fetch() skip the routes; route.fetch() goes through
// fetchWithWafBypass. route.continue() in a page route skips the context route too; use
// route.fallback(). A node fetch() must spread wafBypassHeaders().
function unscopedRequestCalls(source: string): string[] {
  const raw = [
    ...source.matchAll(/\b\w+\.request\.(?:fetch|get|post|put|patch|delete|head)\(|\broute\.(?:fetch|continue)\(/g),
  ];
  const nodeFetch = [...source.matchAll(/(?<![\w.])fetch\([^;]*/g)].filter(
    ([call]) => !call.includes('wafBypassHeaders()')
  );
  return [...raw, ...nodeFetch].map(([call]) => call);
}

const HELPER = path.join('helpers', 'waf-bypass.ts');
// Posts to a Slack webhook, never the stage.
const OFF_STAGE_FETCH = path.join('helpers', 'slack.ts');

const READS_TEST_INFO_ONLY = path.join('helpers', 'api.ts');

const count = (source: string, pattern: RegExp) => (source.match(pattern) ?? []).length;

const files = listSources(E2E_DIR).map(file => ({
  rel: path.relative(E2E_DIR, file),
  source: readFileSync(file, 'utf8'),
}));

describe('e2e WAF bypass coverage', () => {
  it('scans the e2e tree', () => {
    expect(files.map(f => f.rel)).toEqual(expect.arrayContaining(['waf-test.ts', 'fixtures.ts']));
  });

  it('takes the runtime `test` from waf-test.ts, not @playwright/test', () => {
    const offenders = files
      .filter(f => f.rel !== 'waf-test.ts' && !path.basename(f.rel).startsWith('selfhost-'))
      .filter(f => f.rel !== READS_TEST_INFO_ONLY)
      .filter(f => importsRuntimeTest(f.source))
      .map(f => f.rel);
    expect(offenders).toEqual([]);
  });

  // Unit tests mock @playwright/test under this helper, so it keeps the base import; it may only
  // read test.info(), which declares no test and opens no page.
  it(`${READS_TEST_INFO_ONLY} uses the base test for test.info() alone`, () => {
    const source = files.find(f => f.rel === READS_TEST_INFO_ONLY)?.source ?? '';
    expect(count(source, /\btest\.info\(\)/g)).toBeGreaterThan(0);
    expect(count(source, /(?<![\w.@-])test(?:\(|\.(?!com\b))/g)).toBe(count(source, /\btest\.info\(\)/g));
  });

  it('builds request contexts through newWafRequestContext', () => {
    const offenders = files
      .filter(f => f.rel !== HELPER)
      .filter(f => /request\.newContext\(/.test(f.source))
      .map(f => f.rel);
    expect(offenders).toEqual([]);
  });

  it('installs the bypass on every browser context it opens', () => {
    const offenders = files
      .filter(
        f =>
          count(f.source, /^(?!\s*\/\/).*\bbrowser\.newPage\(/gm) > 0 ||
          count(f.source, /^(?!\s*\/\/).*\bbrowser\.newContext\(/gm) > count(f.source, /\binstallWafBypass\(\w+[,)]/g)
      )
      .map(f => f.rel);
    expect(offenders).toEqual([]);
  });

  it('scopes request, route.fetch, route.continue and node fetch calls, which skip the routes', () => {
    const offenders = files
      .filter(f => ![HELPER, OFF_STAGE_FETCH].includes(f.rel) && !path.basename(f.rel).startsWith('selfhost-'))
      .flatMap(f => unscopedRequestCalls(f.source).map(call => `${f.rel}: ${call.slice(0, 60)}`));
    expect(offenders).toEqual([]);
  });

  it('flags the shapes it guards against', () => {
    expect(importsRuntimeTest("import { expect, test } from '@playwright/test';")).toBe(true);
    expect(importsRuntimeTest("import { test as setup } from '@playwright/test';")).toBe(true);
    expect(importsRuntimeTest("import type { test } from '@playwright/test';")).toBe(false);
    expect(importsRuntimeTest("import { expect, type TestInfo } from '@playwright/test';")).toBe(false);
    expect(unscopedRequestCalls("await page.request.get('/api/x', { headers: {} });")).toHaveLength(1);
    expect(unscopedRequestCalls("await context.request.post('/api/x');")).toHaveLength(1);
    expect(unscopedRequestCalls("await scopeWafBypass(this.page.request).get('/api/x');")).toHaveLength(0);
    expect(unscopedRequestCalls('await route.fetch({ headers: { ...wafBypassHeaders() } });')).toHaveLength(1);
    expect(unscopedRequestCalls('await fetchWithWafBypass(route);')).toHaveLength(0);
    expect(unscopedRequestCalls('await route.continue();')).toHaveLength(1);
    expect(unscopedRequestCalls('await route.fallback();')).toHaveLength(0);
    expect(unscopedRequestCalls("await fetch(url, { method: 'DELETE' });")).toHaveLength(1);
    expect(unscopedRequestCalls('await fetch(url, { headers: { ...wafBypassHeaders() } });')).toHaveLength(0);
    expect(unscopedRequestCalls('await ctx.fetch(url);')).toHaveLength(0);
  });
});
