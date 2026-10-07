import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect } from 'vitest';
import { buildDeploymentOpenApiDocument, CONTRACT_SOURCES_FILE, loadDeploymentContracts } from './deployment';

const fixturePath = fileURLToPath(new URL('./__fixtures__/cjsZodContracts.cjs', import.meta.url));
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SKEWED_ADDON = `const { z } = require('zod');
exports.contracts = [
  {
    method: 'get',
    path: '/api/v1/skewed-widgets',
    operationId: 'listSkewedWidgets',
    summary: 'List skewed widgets',
    auth: 'apiKeyOrJwt',
    scopes: ['ai:generate'],
    responses: { 200: { description: 'The widgets.', schema: z.object({ ids: z.array(z.string()) }) } },
  },
];
`;

describe('loadDeploymentContracts', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('returns no contracts when the generated list is missing', async () => {
    const missing = fileURLToPath(new URL('./__fixtures__/absent.cjs', import.meta.url));
    const contracts = await loadDeploymentContracts(missing);
    expect(contracts).toEqual([]);
    expect(buildDeploymentOpenApiDocument('1.0.0', contracts)).toBeNull();
  });

  it('throws when the list does not export a premiumContracts array', async () => {
    const misnamed = fileURLToPath(new URL('./__fixtures__/misnamedExportContracts.cjs', import.meta.url));
    await expect(loadDeploymentContracts(misnamed)).rejects.toThrow(/does not export a premiumContracts array/);
  });

  it('throws when the list has no contract sources beside it', async () => {
    tempRoot = mkdtempSync(join(PACKAGE_ROOT, '.tmp-contract-sources-'));
    const listPath = join(tempRoot, 'premiumContracts.cjs');
    writeFileSync(listPath, 'exports.premiumContracts = [];\n');
    await expect(loadDeploymentContracts(listPath)).rejects.toThrow(
      /premiumContractSources\.generated\.json is missing/
    );
  });

  it('makes contracts built on the CJS zod registrable', async () => {
    const contracts = await loadDeploymentContracts(fixturePath);
    expect(contracts).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec doc is loosely typed for traversal
    const doc = buildDeploymentOpenApiDocument('1.0.0', contracts) as any;
    expect(doc.paths['/api/v1/cjs-widgets'].get.operationId).toBe('listCjsWidgets');
  });

  it('extends the zod the add-on resolves, not the one the list resolves', async () => {
    // Inside this package the list resolves core's zod; the add-on gets its own copy - a
    // separate module instance, the same split as an add-on pinned to another zod version.
    tempRoot = mkdtempSync(join(PACKAGE_ROOT, '.tmp-zod-skew-'));
    const coreZodDir = dirname(createRequire(import.meta.url).resolve('zod/package.json'));
    cpSync(coreZodDir, join(tempRoot, 'addon/node_modules/zod'), { recursive: true, dereference: true });
    writeFileSync(join(tempRoot, 'addon/contracts.cjs'), SKEWED_ADDON);
    mkdirSync(join(tempRoot, 'generated'));
    const listPath = join(tempRoot, 'generated/premiumContracts.cjs');
    writeFileSync(listPath, "exports.premiumContracts = [...require('../addon/contracts.cjs').contracts];\n");
    writeFileSync(join(tempRoot, 'generated', CONTRACT_SOURCES_FILE), JSON.stringify(['../addon/contracts.cjs']));

    const contracts = await loadDeploymentContracts(listPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec doc is loosely typed for traversal
    const doc = buildDeploymentOpenApiDocument('1.0.0', contracts) as any;
    expect(doc.paths['/api/v1/skewed-widgets'].get.operationId).toBe('listSkewedWidgets');
  });
});
