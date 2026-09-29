import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * generateContracts() in scripts/generate-premium-glue.mjs, run for real against a
 * throwaway tree (never the repo, which keeps it clear of the races the sibling
 * premium* tests document). The overlay's source is deliberately absent: the Docker
 * install layer runs codegen before sources are copied, and only the declared path
 * may be used (see premiumMigrationsCodegenNoSources.test.ts).
 */

const SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');

let root: string;

function runCodegen(): void {
  // CI forced off: the fixture overlay is hydrated but never linked, which the
  // script hard-fails when CI === 'true'.
  execFileSync('node', [join(root, 'apps/client/scripts/generate-premium-glue.mjs')], {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, CI: '' },
  });
}

function addOverlay(b4mContributions: Record<string, unknown>): void {
  const overlay = join(root, 'packages/premium/fixtureoverlay');
  mkdirSync(overlay, { recursive: true });
  writeFileSync(
    join(overlay, 'package.json'),
    JSON.stringify({
      name: '@bike4mind/premium-fixtureoverlay',
      exports: { './contracts': './src/api/contracts.ts' },
      b4mContributions,
    }) + '\n'
  );
}

const read = (rel: string) => readFileSync(join(root, 'apps/client/server/premium-generated', rel), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'premium-contracts-codegen-'));
  mkdirSync(join(root, 'apps/client/scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'apps/client/scripts/generate-premium-glue.mjs'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('premium contracts codegen', () => {
  it('emits an empty contract list when no overlay declares contractsExport', () => {
    addOverlay({});
    runCodegen();
    const content = read('premiumContracts.generated.ts');
    expect(content).toContain('export const premiumContracts: readonly EndpointContract[] = [];');
    expect(content).not.toMatch(/^import \{/m);
  });

  it('emits a relative import to the declared source path when one does', () => {
    addOverlay({ contractsExport: '@bike4mind/premium-fixtureoverlay/contracts' });
    runCodegen();
    const content = read('premiumContracts.generated.ts');
    expect(content).toContain(
      "import { contracts as contracts0 } from '../../../../packages/premium/fixtureoverlay/src/api/contracts';"
    );
    expect(content).toContain('...contracts0');
    expect(content).not.toContain("from '@bike4mind/premium-fixtureoverlay");
  });

  it('resets the deployment spec module to null either way', () => {
    addOverlay({ contractsExport: '@bike4mind/premium-fixtureoverlay/contracts' });
    mkdirSync(join(root, 'apps/client/server/premium-generated'), { recursive: true });
    writeFileSync(
      join(root, 'apps/client/server/premium-generated/deploymentOpenApi.generated.ts'),
      'export const deploymentOpenApiSpec = { stale: true };\n'
    );
    runCodegen();
    expect(read('deploymentOpenApi.generated.ts')).toContain(
      'export const deploymentOpenApiSpec: Record<string, unknown> | null = null;'
    );
  });

  it('rejects a contractsExport its package.json exports map does not declare', () => {
    addOverlay({ contractsExport: '@bike4mind/premium-fixtureoverlay/missing' });
    expect(runCodegen).toThrow(/cannot resolve contractsExport/);
  });
});
