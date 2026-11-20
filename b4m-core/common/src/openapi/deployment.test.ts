import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildDeploymentOpenApiDocument } from './deployment';
import { CONTRACTS } from '../api-contract';
import type { EndpointContract } from '../api-contract/types';
import { ApiKeyScope, PUBLIC_DOC_API_KEY_SCOPES } from '../types/entities/UserApiKeyTypes';

// Own module graph per vitest file, so registering this fixture cannot leak into the
// core document built in document.test.ts.
const addOnContract: EndpointContract = {
  method: 'get',
  path: '/api/v1/widgets',
  operationId: 'listWidgets',
  summary: 'List widgets',
  tags: ['Widgets', 'AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  responses: { 200: { description: 'The widgets.', schema: z.object({ ids: z.array(z.string()) }) } },
};

describe('buildDeploymentOpenApiDocument', () => {
  it('returns null when no add-on contributes a contract', () => {
    expect(buildDeploymentOpenApiDocument('1.0.0', [])).toBeNull();
  });

  // Every case below registers into the module-global registry, which cannot be
  // undone, so the document is built once and each test reads it.

  const hiddenScopeContract: EndpointContract = {
    ...addOnContract,
    path: '/api/v1/hidden-scope',
    operationId: 'hiddenScopeOp',
    scopes: [ApiKeyScope.OPTIHASHI_COMPUTE],
  };
  const doc = buildDeploymentOpenApiDocument('1.0.0', [addOnContract, hiddenScopeContract]) as any;
  const scopesList = (): string[] =>
    (doc.info.description.split('\n## Scopes\n')[1].split('\n## ')[0] as string)
      .split('\n')
      .filter(line => line.startsWith('- '))
      .map(line => line.slice(3, -1));

  it('carries every core operation alongside the add-on one', () => {
    for (const contract of CONTRACTS) {
      expect(doc.paths[contract.path]?.[contract.method]?.operationId).toBe(contract.operationId);
    }
    const op = doc.paths['/api/v1/widgets'].get;
    expect(op.operationId).toBe('listWidgets');
    expect(op['x-required-scopes']).toEqual([ApiKeyScope.AI_GENERATE]);
  });

  it('declares an add-on tag the core tag list lacks, once, without duplicating a core tag', () => {
    const names = doc.tags.map((t: { name: string }) => t.name);
    expect(names.filter((n: string) => n === 'Widgets')).toHaveLength(1);
    expect(names.filter((n: string) => n === 'AI')).toHaveLength(1);
  });

  it('lists a built-in scope an add-on operation requires although the core spec leaves it unlisted', () => {
    expect(PUBLIC_DOC_API_KEY_SCOPES).not.toContain(ApiKeyScope.OPTIHASHI_COMPUTE);
    expect(scopesList()).toContain(ApiKeyScope.OPTIHASHI_COMPUTE);
    expect(scopesList()).toEqual(expect.arrayContaining([...PUBLIC_DOC_API_KEY_SCOPES]));
  });

  it('lists every x-required-scopes value in the document', () => {
    const listed = new Set(scopesList());
    const required = new Set<string>();
    for (const item of Object.values<Record<string, { 'x-required-scopes'?: string[] }>>(doc.paths)) {
      for (const op of Object.values(item)) for (const s of op?.['x-required-scopes'] ?? []) required.add(s);
    }
    expect([...required].filter(s => !listed.has(s))).toEqual([]);
  });

  it('rejects an add-on contract that reuses a core operationId', () => {
    expect(() =>
      buildDeploymentOpenApiDocument('1.0.0', [
        { ...addOnContract, path: '/api/v1/other', operationId: CONTRACTS[0].operationId },
      ])
    ).toThrow(/Duplicate operationId/);
  });
});
