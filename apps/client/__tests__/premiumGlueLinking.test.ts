import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end guard for the codegen's linked/unlinked split.
 *
 * A hydrated overlay whose package is NOT linked into node_modules must get the
 * ABSENT form for all bare-specifier glue (emitting real imports would fail every
 * typecheck/build with cannot-find-module errors), while infra glue keeps the
 * PRESENT form (it imports overlay source relatively and needs no link).
 *
 * Runs the real script inside a sandbox tree, since its paths derive from its own
 * location: sandbox/apps/client/scripts/ next to sandbox/packages/premium/.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const PKG_NAME = '@bike4mind/premium-fakeoverlay';

let sandbox: string;
let script: string;
let clientRoot: string;

function runCodegen() {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-glue-test-'));
  clientRoot = join(sandbox, 'apps/client');
  script = join(clientRoot, 'scripts/generate-premium-glue.mjs');

  mkdirSync(join(clientRoot, 'scripts'), { recursive: true });
  cpSync(REAL_SCRIPT, script);
  mkdirSync(join(clientRoot, 'pages/api'), { recursive: true });

  const overlayDir = join(sandbox, 'packages/premium/fakeoverlay');
  mkdirSync(join(overlayDir, 'src'), { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({
      name: PKG_NAME,
      b4mContributions: {
        spaRoutesExport: `${PKG_NAME}/routes`,
        navItemsExport: `${PKG_NAME}/nav`,
        llmToolsExport: `${PKG_NAME}/tools`,
        apiRouteStubs: [{ generatedPath: 'pages/api/premium-fakeoverlay/ping.ts', exportFrom: `${PKG_NAME}/api/ping` }],
        serverHandlerStubs: [
          { generatedPath: 'server/premium-generated/fakeoverlay.ts', exportFrom: `${PKG_NAME}/handlers` },
        ],
        infra: true,
      },
    })
  );
  writeFileSync(join(overlayDir, 'src/infra.ts'), 'export function contributeInfra() {}\n');

  writeFileSync(
    join(sandbox, 'sst.config.ts'),
    `await import('./infra/premium-generated/fakeoverlay-infra.generated');\n`
  );
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('hydrated but UNLINKED overlay', () => {
  it('emits the absent form for bare-specifier glue and warns', () => {
    const { stderr } = runCodegen();

    expect(stderr).toContain('not');
    expect(stderr).toContain('resolvable from apps/client');

    const routes = readFileSync(join(clientRoot, 'app/premium-generated/premiumRoutes.generated.ts'), 'utf8');
    expect(routes).not.toContain(PKG_NAME);
    expect(routes).toContain('premiumRoutes: PremiumRouteDescriptor[] = []');

    const tools = readFileSync(join(clientRoot, 'server/premium-generated/premiumLlmTools.generated.ts'), 'utf8');
    expect(tools).not.toContain(PKG_NAME);

    expect(existsSync(join(clientRoot, 'pages/api/premium-fakeoverlay'))).toBe(false);
    expect(existsSync(join(clientRoot, 'server/premium-generated/fakeoverlay.ts'))).toBe(false);
  });

  it('still emits the PRESENT infra glue (relative import needs no link)', () => {
    runCodegen();
    const infra = readFileSync(join(sandbox, 'infra/premium-generated/fakeoverlay-infra.generated.ts'), 'utf8');
    expect(infra).toContain(`from '../../packages/premium/fakeoverlay/src/infra'`);
  });
});

describe('hydrated AND linked overlay', () => {
  beforeAll(() => {
    // A plain directory is enough: the script checks resolvability by presence in
    // the node_modules chain, exactly where pnpm would place the workspace link.
    mkdirSync(join(clientRoot, 'node_modules', PKG_NAME), { recursive: true });
  });

  it('emits real imports and no warning', () => {
    const { stderr } = runCodegen();
    expect(stderr).not.toContain('resolvable from apps/client');

    const routes = readFileSync(join(clientRoot, 'app/premium-generated/premiumRoutes.generated.ts'), 'utf8');
    expect(routes).toContain(`from '${PKG_NAME}/routes'`);

    const stub = readFileSync(join(clientRoot, 'pages/api/premium-fakeoverlay/ping.ts'), 'utf8');
    expect(stub).toContain(`export { default } from '${PKG_NAME}/api/ping'`);

    expect(existsSync(join(clientRoot, 'server/premium-generated/fakeoverlay.ts'))).toBe(true);
  });
});
