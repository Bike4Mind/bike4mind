import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { CONTRACT_SOURCES_FILE } from './deployment';
import {
  GENERATED_DIR,
  MONOREPO_ROOT,
  generateDeploymentOpenApiModule,
  writeDeploymentOpenApiModule,
} from './writeDeploymentModule';

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

// Parameterized by name: the registry is module-global, so each registering test needs its own op.
const addonContracts = (name: string) => `import { z } from 'zod';

export const contracts = [
  {
    method: 'get',
    path: '/api/v1/${name}-widgets',
    operationId: 'list${name}Widgets',
    summary: 'List generated widgets',
    tags: ['Generated Widgets'],
    auth: 'apiKeyOrJwt',
    scopes: ['ai:generate'],
    responses: { 200: { description: 'The widgets.', schema: z.object({ ids: z.array(z.string()) }) } },
  },
];
`;

// Mirrors the codegen: the list, its sources sidecar, and the add-on module it imports.
function writeAddonTree(repoRoot: string, name: string): void {
  mkdirSync(join(repoRoot, GENERATED_DIR), { recursive: true });
  writeFileSync(join(repoRoot, GENERATED_DIR, 'premiumContracts.generated.ts'), GENERATED_LIST);
  writeFileSync(join(repoRoot, GENERATED_DIR, CONTRACT_SOURCES_FILE), JSON.stringify(['../../../addon/contracts']));
  mkdirSync(join(repoRoot, 'apps/addon'), { recursive: true });
  writeFileSync(join(repoRoot, 'apps/addon/contracts.ts'), addonContracts(name));
}

function readWrittenSpec(outputPath: string) {
  const source = readFileSync(outputPath, 'utf8');
  return { source, doc: JSON.parse(source.slice(source.indexOf('= ') + 2, source.lastIndexOf(';'))) };
}

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
    writeAddonTree(repoRoot, 'generated');

    const { outputPath, contractCount } = await writeDeploymentOpenApiModule({ repoRoot, version: '1.0.0' });

    expect(contractCount).toBe(1);
    const { source, doc } = readWrittenSpec(outputPath);
    expect(source).toContain("import type { DeploymentOpenApiSpec } from '../utils/openApiSpecHandler';");
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.paths['/api/v1/generated-widgets'].get.operationId).toBe('listgeneratedWidgets');
    expect(doc.tags).toContainEqual({ name: 'Generated Widgets' });
  });
});

describe('generateDeploymentOpenApiModule', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(PACKAGE_ROOT, '.tmp-generate-deployment-'));
    mkdirSync(join(repoRoot, 'b4m-core/common'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const writePackageJson = (pkg: Record<string, unknown>) =>
    writeFileSync(join(repoRoot, 'b4m-core/common/package.json'), JSON.stringify(pkg));

  it('stamps the spec with the version from b4m-core/common/package.json', async () => {
    writePackageJson({ name: '@bike4mind/common', version: '7.7.7' });
    writeAddonTree(repoRoot, 'versioned');

    const { outputPath } = await generateDeploymentOpenApiModule(repoRoot);

    expect(readWrittenSpec(outputPath).doc.info.version).toBe('7.7.7');
  });

  it('throws instead of writing a spec without a version', async () => {
    writePackageJson({ name: '@bike4mind/common' });
    writeAddonTree(repoRoot, 'unversioned');

    await expect(generateDeploymentOpenApiModule(repoRoot)).rejects.toThrow(/has no version/);
  });

  it('reads a version from the real package.json by default', () => {
    const pkg = JSON.parse(readFileSync(resolve(MONOREPO_ROOT, 'b4m-core/common/package.json'), 'utf8'));
    expect(pkg.version).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+/));
  });
});
