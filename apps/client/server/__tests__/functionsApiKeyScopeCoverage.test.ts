// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import {
  ApiKeyScope,
  CONFINED_API_KEY_SCOPES,
  CONTRACTS,
  cancelFunctionCallContract,
  getFunctionCallContract,
  getFunctionContract,
  invokeFunctionContract,
  listFunctionsContract,
} from '@bike4mind/common';
import { decideScopeGate } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import { DERIVED_API_KEY_SCOPE_ENDPOINTS } from '@bike4mind/server-utils/app/constants/apiKeyScopeEndpoints.generated';

/**
 * `functions:invoke` is confined, so a key holding it holds nothing else: every /api/v1/functions route must name it,
 * through its contract, and no other route may accept it. A source scan is what fails when a new file in the family
 * builds its router some other way.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route.
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'v1', 'functions');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR);

const CONTRACTS_BY_IDENTIFIER = {
  listFunctionsContract,
  getFunctionContract,
  invokeFunctionContract,
  getFunctionCallContract,
  cancelFunctionCallContract,
};

describe('public /api/v1/functions routes gate on functions:invoke through their contract', () => {
  it('finds the route files', () => {
    expect(files).toHaveLength(5);
  });

  it.each(files.map(f => [path.relative(ROUTES_DIR, f), f]))('%s', (rel, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source, `${rel} must not call baseApi(...)`).not.toContain('baseApi(');
    expect(source, `${rel} must build its router with nextRouteForContract(...)`).toContain('nextRouteForContract(');
  });

  it('builds every router from a pinned contract, and gives every pinned contract a router', () => {
    const routed = files.flatMap(f =>
      [...readFileSync(f, 'utf8').matchAll(/nextRouteForContract\(\s*(\w+)/g)].map(m => m[1])
    );
    expect(routed.sort()).toEqual(Object.keys(CONTRACTS_BY_IDENTIFIER).sort());
  });

  it('lists exactly these contracts under /api/v1/functions', () => {
    const family = CONTRACTS.filter(c => c.path.startsWith('/api/v1/functions'));
    expect(new Set(family)).toEqual(new Set(Object.values(CONTRACTS_BY_IDENTIFIER)));
  });

  it.each(Object.values(CONTRACTS_BY_IDENTIFIER).map(c => [c.operationId, c] as const))(
    '%s names functions:invoke and nothing else',
    (_operationId, contract) => {
      expect(contract.auth).toBe('apiKeyOrJwt');
      expect(contract.scopes).toEqual([ApiKeyScope.FUNCTIONS_INVOKE]);
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_INVOKE], new Set())).toEqual({
        outcome: 'allow',
      });
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.AI_CHAT], new Set())).toEqual({ outcome: 'deny' });
    }
  );

  it('keeps functions:invoke confined, so a functions key is refused on routes that do not name it', () => {
    expect(CONFINED_API_KEY_SCOPES).toContain(ApiKeyScope.FUNCTIONS_INVOKE);
    expect(decideScopeGate(undefined, [ApiKeyScope.FUNCTIONS_INVOKE], new Set())).toEqual({ outcome: 'deny' });
    expect(decideScopeGate([ApiKeyScope.READ_NOTEBOOKS], [ApiKeyScope.FUNCTIONS_INVOKE], new Set())).toEqual({
      outcome: 'deny',
    });
  });

  it('opens exactly the MCP endpoint and the five functions routes to a functions:invoke key', () => {
    expect(DERIVED_API_KEY_SCOPE_ENDPOINTS[ApiKeyScope.FUNCTIONS_INVOKE]).toEqual([
      'POST /api/mcp/functions',
      'GET /api/v1/functions',
      'GET /api/v1/functions/:id',
      'POST /api/v1/functions/:id/invoke',
      'GET /api/v1/functions/calls/:call_id',
      'POST /api/v1/functions/calls/:call_id/cancel',
    ]);
  });
});
