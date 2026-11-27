// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import {
  ApiKeyScope,
  CONFINED_API_KEY_SCOPES,
  CONTRACTS,
  cancelFunctionCallContract,
  createFunctionContract,
  deleteFunctionContract,
  findFunctionRecipientContract,
  getAuthoredFunctionContract,
  getFunctionCallContract,
  getFunctionCallSummaryContract,
  getFunctionContract,
  getFunctionShareContract,
  invokeFunctionContract,
  isMintableConfinedScopeSet,
  listAuthoredFunctionsContract,
  listFunctionsContract,
  pinFunctionDataContract,
  promoteFunctionContract,
  reviewFunctionContract,
  runFunctionTestsContract,
  saveFunctionCodeContract,
  setFunctionExamplesContract,
  setFunctionSourcesContract,
  shareFunctionContract,
  unpinFunctionDataContract,
  unshareFunctionContract,
  updateFunctionContract,
} from '@bike4mind/common';
import { decideScopeGate } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import { DERIVED_API_KEY_SCOPE_ENDPOINTS } from '@bike4mind/server-utils/app/constants/apiKeyScopeEndpoints.generated';

/**
 * `functions:invoke` and `functions:author` are confined, so a key holding them holds nothing else: every
 * /api/v1/functions route must name exactly one of them through its contract, and no other route may accept either.
 * A source scan is what fails when a new file in the family builds its router some other way.
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

const INVOKE_CONTRACTS = {
  listFunctionsContract,
  getFunctionContract,
  reviewFunctionContract,
  invokeFunctionContract,
  getFunctionCallContract,
  cancelFunctionCallContract,
};

const AUTHOR_CONTRACTS = {
  createFunctionContract,
  listAuthoredFunctionsContract,
  getAuthoredFunctionContract,
  saveFunctionCodeContract,
  updateFunctionContract,
  deleteFunctionContract,
  setFunctionExamplesContract,
  runFunctionTestsContract,
  pinFunctionDataContract,
  unpinFunctionDataContract,
  setFunctionSourcesContract,
  promoteFunctionContract,
  getFunctionShareContract,
  shareFunctionContract,
  unshareFunctionContract,
  findFunctionRecipientContract,
  getFunctionCallSummaryContract,
};

const CONTRACTS_BY_IDENTIFIER = { ...INVOKE_CONTRACTS, ...AUTHOR_CONTRACTS };

describe('public /api/v1/functions routes gate on one functions scope through their contract', () => {
  it('finds the route files', () => {
    expect(files).toHaveLength(18);
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

  it.each(Object.values(INVOKE_CONTRACTS).map(c => [c.operationId, c] as const))(
    '%s names functions:invoke and nothing else, so functions:author alone calls nothing',
    (_operationId, contract) => {
      expect(contract.auth).toBe('apiKeyOrJwt');
      expect(contract.scopes).toEqual([ApiKeyScope.FUNCTIONS_INVOKE]);
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_INVOKE], new Set())).toEqual({
        outcome: 'allow',
      });
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_AUTHOR], new Set())).toEqual({
        outcome: 'deny',
      });
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.AI_CHAT], new Set())).toEqual({ outcome: 'deny' });
    }
  );

  it.each(Object.values(AUTHOR_CONTRACTS).map(c => [c.operationId, c] as const))(
    '%s names functions:author and nothing else, so functions:invoke alone authors nothing',
    (_operationId, contract) => {
      expect(contract.auth).toBe('apiKeyOrJwt');
      expect(contract.scopes).toEqual([ApiKeyScope.FUNCTIONS_AUTHOR]);
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_AUTHOR], new Set())).toEqual({
        outcome: 'allow',
      });
      expect(
        decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_INVOKE, ApiKeyScope.FUNCTIONS_AUTHOR], new Set())
      ).toEqual({ outcome: 'allow' });
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_INVOKE], new Set())).toEqual({
        outcome: 'deny',
      });
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.WRITE_NOTEBOOKS], new Set())).toEqual({ outcome: 'deny' });
    }
  );

  it('keeps both scopes confined, so a functions key is refused on routes that do not name one', () => {
    for (const scope of [ApiKeyScope.FUNCTIONS_INVOKE, ApiKeyScope.FUNCTIONS_AUTHOR]) {
      expect(CONFINED_API_KEY_SCOPES).toContain(scope);
      expect(decideScopeGate(undefined, [scope], new Set())).toEqual({ outcome: 'deny' });
      expect(decideScopeGate([ApiKeyScope.READ_NOTEBOOKS], [scope], new Set())).toEqual({ outcome: 'deny' });
    }
    expect(
      decideScopeGate(
        [ApiKeyScope.WRITE_NOTEBOOKS],
        [ApiKeyScope.FUNCTIONS_INVOKE, ApiKeyScope.FUNCTIONS_AUTHOR],
        new Set()
      )
    ).toEqual({ outcome: 'deny' });
  });

  it('mints the two together, and neither with any other scope', () => {
    expect(isMintableConfinedScopeSet([ApiKeyScope.FUNCTIONS_INVOKE, ApiKeyScope.FUNCTIONS_AUTHOR])).toBe(true);
    expect(isMintableConfinedScopeSet([ApiKeyScope.FUNCTIONS_AUTHOR])).toBe(true);
    expect(isMintableConfinedScopeSet([ApiKeyScope.FUNCTIONS_AUTHOR, ApiKeyScope.WRITE_NOTEBOOKS])).toBe(false);
    expect(isMintableConfinedScopeSet([ApiKeyScope.FUNCTIONS_INVOKE, ApiKeyScope.SLACK_POST])).toBe(false);
  });

  it('opens exactly the MCP endpoint and the six calling routes to a functions:invoke key', () => {
    expect(DERIVED_API_KEY_SCOPE_ENDPOINTS[ApiKeyScope.FUNCTIONS_INVOKE]).toEqual([
      'POST /api/mcp/functions',
      'GET /api/v1/functions',
      'GET /api/v1/functions/:id',
      'POST /api/v1/functions/:id/invoke',
      'POST /api/v1/functions/:id/review',
      'GET /api/v1/functions/calls/:call_id',
      'POST /api/v1/functions/calls/:call_id/cancel',
    ]);
  });

  it('opens exactly the seventeen authoring operations to a functions:author key', () => {
    expect(DERIVED_API_KEY_SCOPE_ENDPOINTS[ApiKeyScope.FUNCTIONS_AUTHOR]).toEqual([
      'POST /api/v1/functions',
      'PATCH|DELETE /api/v1/functions/:id',
      'GET /api/v1/functions/:id/calls',
      'PUT /api/v1/functions/:id/code',
      'POST /api/v1/functions/:id/data',
      'DELETE /api/v1/functions/:id/data/:name',
      'PUT /api/v1/functions/:id/examples',
      'POST /api/v1/functions/:id/promote',
      'GET /api/v1/functions/:id/recipient',
      'GET|PUT|DELETE /api/v1/functions/:id/share',
      'GET /api/v1/functions/:id/source',
      'PUT /api/v1/functions/:id/sources',
      'POST /api/v1/functions/:id/test-runs',
      'GET /api/v1/functions/mine',
    ]);
  });
});
