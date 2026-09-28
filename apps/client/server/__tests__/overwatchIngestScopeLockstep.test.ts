// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * The Overwatch ingest route names its scope twice on purpose: once as the `baseApi`
 * gate, which is what confines an ingest key to this one route (CONFINED_SCOPES in
 * apiKeyScopeGate.ts), and once in-handler, which is what gives the route its own error
 * shape and still guards callers that never traverse `baseApi`. Nothing else fails when
 * the two drift - change one and the other keeps enforcing the old scope - so this scan
 * is what backs the "must stay in sync" comment in events.ts.
 *
 * Scanned as source rather than imported because `baseApi` closes over its options and
 * returns a bare next-connect handler: the declared scope is unreachable at runtime.
 * Lives outside pages/ because that is where this repo keeps source-scanning tests - the
 * eslint guard on tree-walking in pages/ tests names this directory by hand, and the
 * sibling scope-coverage scans are here for the same reason.
 */
const EVENTS_ROUTE = path.join(__dirname, '..', '..', 'pages', 'api', 'overwatch', 'v1', 'events.ts');

/**
 * Comments are stripped before scanning because events.ts's `requiredScopes` prose sits
 * directly above the declaration it describes - without this, a comment naming a scope
 * would read as a second declaration and the scan would stop meaning anything. Truncates
 * a `//` inside a string literal too, which is harmless for the two patterns below.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Bodies of each `requiredScopes: [...]` array literal. More than one is itself a finding. */
function declaredScopeBlocks(source: string): string[] {
  return [...stripComments(source).matchAll(/requiredScopes\s*:\s*\[([^\]]*)\]/g)].map(m => m[1]);
}

/** Scopes named by an in-handler `req.apiKeyInfo.scopes.includes(ApiKeyScope.X)` check. */
function inHandlerScopes(source: string): string[] {
  const matches = stripComments(source).matchAll(/apiKeyInfo\.scopes\.includes\(\s*ApiKeyScope\.([A-Z0-9_]+)\s*\)/g);
  return [...matches].map(m => m[1]);
}

function scopeNames(block: string): string[] {
  return [...block.matchAll(/ApiKeyScope\.([A-Z0-9_]+)/g)].map(m => m[1]);
}

const sortedUnique = (names: string[]): string[] => [...new Set(names)].sort();

describe('overwatch ingest route: declared scope and in-handler check stay in lockstep', () => {
  const source = readFileSync(EVENTS_ROUTE, 'utf8');
  const blocks = declaredScopeBlocks(source);

  it('declares exactly one requiredScopes array literal', () => {
    // A named constant (`requiredScopes: OVERWATCH_SCOPES`) would match zero here. That is
    // deliberate: this guard should fail loudly and be re-pointed, not silently scan nothing.
    expect(blocks, 'events.ts must declare requiredScopes as a single inline array literal').toHaveLength(1);
  });

  it('names the same scope at the baseApi gate and in the handler', () => {
    const declared = sortedUnique(scopeNames(blocks[0] ?? ''));
    const inHandler = sortedUnique(inHandlerScopes(source));

    // Two empty sets compare equal, so non-emptiness is asserted before the comparison:
    // a regex that stopped matching would otherwise pass this test having checked nothing.
    expect(declared, 'no scope found in requiredScopes').not.toHaveLength(0);
    expect(inHandler, 'no in-handler apiKeyInfo.scopes.includes check found').not.toHaveLength(0);
    expect(declared, 'requiredScopes and the in-handler scope check have drifted').toEqual(inHandler);
  });

  it('pins both sites to the Overwatch ingest scope', () => {
    // The lockstep check above only proves the two agree. Both being repointed together is
    // still a confinement regression, so the scope itself is pinned: an ingest gate quietly
    // becoming, say, an ai:chat gate would otherwise pass every other assertion here.
    const declared = sortedUnique(scopeNames(blocks[0] ?? ''));
    expect(declared).toEqual(['OVERWATCH_INGEST_WRITE']);
    // The wire value, not just the identifier: what confinement is keyed on is the string.
    expect(ApiKeyScope.OVERWATCH_INGEST_WRITE).toBe('overwatch-ingest:write');
  });

  it('names only real ApiKeyScope members', () => {
    const named = sortedUnique([...scopeNames(blocks[0] ?? ''), ...inHandlerScopes(source)]);
    const scopeValues = Object.values(ApiKeyScope) as string[];
    for (const name of named) {
      const value = (ApiKeyScope as unknown as Record<string, string>)[name];
      expect(scopeValues, `${name} is not a member of ApiKeyScope`).toContain(value);
    }
  });
});

describe('scope extractors', () => {
  it('reads the scope out of a multi-line baseApi options object', () => {
    const source = [
      'const handler = baseApi({',
      '  maxBodySize: 256 * 1024,',
      '  requiredScopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],',
      '}).post(async (req, res) => {});',
    ].join('\n');
    expect(scopeNames(declaredScopeBlocks(source)[0])).toEqual(['OVERWATCH_INGEST_WRITE']);
  });

  it('reads the scope out of a single-line baseApi call', () => {
    const source = 'baseApi({ requiredScopes: [ApiKeyScope.CC_BRIDGE] }).post(h);';
    expect(scopeNames(declaredScopeBlocks(source)[0])).toEqual(['CC_BRIDGE']);
  });

  it('ignores a scope named only in a comment', () => {
    const source = [
      '// requiredScopes: [ApiKeyScope.ADMIN] was considered and rejected',
      '/* requiredScopes: [ApiKeyScope.EMBED_CHAT] */',
      'const handler = baseApi({ requiredScopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE] });',
      '// if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.ADMIN)) {}',
      'if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE)) {}',
    ].join('\n');
    expect(declaredScopeBlocks(source)).toHaveLength(1);
    expect(scopeNames(declaredScopeBlocks(source)[0])).toEqual(['OVERWATCH_INGEST_WRITE']);
    expect(inHandlerScopes(source)).toEqual(['OVERWATCH_INGEST_WRITE']);
  });

  it('finds every in-handler check, not just the first', () => {
    const source = [
      'if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.AI_CHAT)) {}',
      'if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.AI_GENERATE)) {}',
    ].join('\n');
    expect(inHandlerScopes(source)).toEqual(['AI_CHAT', 'AI_GENERATE']);
  });

  it('returns nothing when requiredScopes is a named constant rather than a literal', () => {
    expect(declaredScopeBlocks('baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })')).toHaveLength(0);
  });
});
