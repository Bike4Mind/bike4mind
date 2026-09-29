import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { GENERATED_DIR, MONOREPO_ROOT, writeDeploymentOpenApiModule } from './writeDeploymentModule';

// The temp tree lives inside this package so the add-on's `zod` import resolves the way it
// does from a mounted add-on.
const PACKAGE_ROOT = resolve(MONOREPO_ROOT, 'b4m-core/common');

// Same shape generate-premium-glue.mjs emits for one contributor.
const GENERATED_LIST = [
  "import type { EndpointContract } from '@bike4mind/common';",
  "import { contracts as contracts0 } from '../../../addon/contracts';",
  '',
  'export const premiumContracts: readonly EndpointContract[] = [',
  '  ...contracts0',
  '];',
  '',
].join('\n');

const ADDON_CONTRACTS = `import { z } from 'zod';

export const contracts = [
  {
    method: 'get',
    path: '/api/v1/generated-widgets',
    operationId: 'listGeneratedWidgets',
    summary: 'List generated widgets',
    tags: ['Generated Widgets'],
    auth: 'apiKeyOrJwt',
    scopes: ['ai:generate'],
    responses: { 200: { description: 'The widgets.', schema: z.object({ ids: z.array(z.string()) }) } },
  },
];
`;

describe('writeDeploymentOpenApiModule', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(PACKAGE_ROOT, '.tmp-deployment-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('resolves the real monorepo root, where the client consumes the module', () => {
    expect(existsSync(resolve(MONOREPO_ROOT, 'apps/client/package.json'))).toBe(true);
    expect(existsSync(resolve(MONOREPO_ROOT, 'b4m-core/common/package.json'))).toBe(true);
  });

  it('writes the null form when no contract list was generated', async () => {
    const { outputPath, contractCount } = await writeDeploymentOpenApiModule({ repoRoot, version: '1.0.0' });

    expect(outputPath).toBe(resolve(repoRoot, GENERATED_DIR, 'deploymentOpenApi.generated.ts'));
    expect(contractCount).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toContain(
      'export const deploymentOpenApiSpec: DeploymentOpenApiSpec | null = null;'
    );
  });

  it('writes a spec containing the add-on contracts from the codegen-emitted list', async () => {
    mkdirSync(join(repoRoot, GENERATED_DIR), { recursive: true });
    writeFileSync(join(repoRoot, GENERATED_DIR, 'premiumContracts.generated.ts'), GENERATED_LIST);
    mkdirSync(join(repoRoot, 'apps/addon'), { recursive: true });
    writeFileSync(join(repoRoot, 'apps/addon/contracts.ts'), ADDON_CONTRACTS);

    const { outputPath, contractCount } = await writeDeploymentOpenApiModule({ repoRoot, version: '1.0.0' });

    expect(contractCount).toBe(1);
    const source = readFileSync(outputPath, 'utf8');
    expect(source).toContain("import type { DeploymentOpenApiSpec } from '../utils/openApiSpecHandler';");
    const json = source.slice(source.indexOf('= ') + 2, source.lastIndexOf(';'));
    const doc = JSON.parse(json);
    expect(doc.paths['/api/v1/generated-widgets'].get.operationId).toBe('listGeneratedWidgets');
    expect(doc.tags).toContainEqual({ name: 'Generated Widgets' });
  });
});
