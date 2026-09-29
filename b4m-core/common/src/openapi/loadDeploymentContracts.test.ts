import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildDeploymentOpenApiDocument, loadDeploymentContracts } from './deployment';

const fixturePath = fileURLToPath(new URL('./__fixtures__/cjsZodContracts.cjs', import.meta.url));

describe('loadDeploymentContracts', () => {
  it('returns no contracts when the generated list is missing', async () => {
    const missing = fileURLToPath(new URL('./__fixtures__/absent.cjs', import.meta.url));
    const contracts = await loadDeploymentContracts(missing);
    expect(contracts).toEqual([]);
    expect(buildDeploymentOpenApiDocument('1.0.0', contracts)).toBeNull();
  });

  it('makes contracts built on the CJS zod registrable', async () => {
    const contracts = await loadDeploymentContracts(fixturePath);
    expect(contracts).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec doc is loosely typed for traversal
    const doc = buildDeploymentOpenApiDocument('1.0.0', contracts) as any;
    expect(doc.paths['/api/v1/cjs-widgets'].get.operationId).toBe('listCjsWidgets');
  });
});
