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
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when
  // CI === 'true' (pinned by its own test below), and this suite runs the
  // unlinked scenarios on CI runners where CI=true is ambient.
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

// Explicit per-scenario link state, so neither describe depends on the other
// having run first. Mirrors a pnpm workspace link: a real package dir (with
// package.json) reachable from apps/client's node_modules chain.
function linkOverlay() {
  const pkgDir = join(clientRoot, 'node_modules', PKG_NAME);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: PKG_NAME }));
}

function unlinkOverlay() {
  rmSync(join(clientRoot, 'node_modules'), { recursive: true, force: true });
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
      exports: {
        './server/migrations': './src/server/migrations.ts',
      },
      b4mContributions: {
        spaRoutesExport: `${PKG_NAME}/routes`,
        navItemsExport: `${PKG_NAME}/nav`,
        notebookSidenavExport: `${PKG_NAME}/sidenav`,
        llmToolsExport: `${PKG_NAME}/tools`,
        migrationsExport: `${PKG_NAME}/server/migrations`,
        apiRouteStubs: [{ generatedPath: 'pages/api/premium-fakeoverlay/ping.ts', exportFrom: `${PKG_NAME}/api/ping` }],
        serverHandlerStubs: [
          { generatedPath: 'server/premium-generated/fakeoverlay.ts', exportFrom: `${PKG_NAME}/handlers` },
        ],
        infra: true,
      },
    })
  );
  writeFileSync(join(overlayDir, 'src/infra.ts'), 'export function contributeInfra() {}\n');
  mkdirSync(join(overlayDir, 'src/server'), { recursive: true });
  writeFileSync(join(overlayDir, 'src/server/migrations.ts'), 'export const migrations = [];\n');

  writeFileSync(
    join(sandbox, 'sst.config.ts'),
    `await import('./infra/premium-generated/fakeoverlay-infra.generated');\n`
  );
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('hydrated but UNLINKED overlay', () => {
  beforeAll(() => {
    unlinkOverlay();
  });

  it('emits the absent form for bare-specifier glue and warns', () => {
    const { stderr } = runCodegen();

    expect(stderr).toContain('is not resolvable from apps/client');

    const routes = readFileSync(join(clientRoot, 'app/premium-generated/premiumRoutes.generated.ts'), 'utf8');
    expect(routes).not.toContain(PKG_NAME);
    expect(routes).toContain('premiumRoutes: PremiumRouteDescriptor[] = []');

    const tools = readFileSync(join(clientRoot, 'server/premium-generated/premiumLlmTools.generated.ts'), 'utf8');
    expect(tools).not.toContain(PKG_NAME);

    const nav = readFileSync(join(clientRoot, 'app/premium-generated/premiumNavItems.generated.ts'), 'utf8');
    expect(nav).not.toContain(PKG_NAME);
    expect(nav).toContain('premiumNavItems: PremiumNavDescriptor[] = []');

    const sidenav = readFileSync(join(clientRoot, 'app/premium-generated/premiumNotebookSidenav.generated.ts'), 'utf8');
    expect(sidenav).not.toContain(PKG_NAME);
    expect(sidenav).toContain('premiumNotebookSidenav: PremiumNotebookSidenav = null');

    expect(existsSync(join(clientRoot, 'pages/api/premium-fakeoverlay'))).toBe(false);
    expect(existsSync(join(clientRoot, 'server/premium-generated/fakeoverlay.ts'))).toBe(false);
  });

  it('still emits the PRESENT relative-import glue (infra + migrations need no link)', () => {
    runCodegen();
    const infra = readFileSync(join(sandbox, 'infra/premium-generated/fakeoverlay-infra.generated.ts'), 'utf8');
    expect(infra).toContain(`from '../../packages/premium/fakeoverlay/src/infra'`);

    const migrations = readFileSync(join(sandbox, 'packages/scripts/migrate/migrations/premium.generated.ts'), 'utf8');
    expect(migrations).toContain('premium/fakeoverlay/src/server/migrations');
    expect(migrations).not.toContain(PKG_NAME);
  });

  it('refuses the hydrated-but-unlinked state outright when CI=true', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to emit absent glue');
  });
});

describe('hydrated AND linked overlay', () => {
  beforeAll(() => {
    linkOverlay();
  });

  it('emits real imports and no warning', () => {
    const { stderr } = runCodegen();
    expect(stderr).not.toContain('is not resolvable from apps/client');

    const routes = readFileSync(join(clientRoot, 'app/premium-generated/premiumRoutes.generated.ts'), 'utf8');
    expect(routes).toContain(`from '${PKG_NAME}/routes'`);

    const nav = readFileSync(join(clientRoot, 'app/premium-generated/premiumNavItems.generated.ts'), 'utf8');
    expect(nav).toContain(`from '${PKG_NAME}/nav'`);

    const sidenav = readFileSync(join(clientRoot, 'app/premium-generated/premiumNotebookSidenav.generated.ts'), 'utf8');
    expect(sidenav).toContain(`import('${PKG_NAME}/sidenav')`);

    const stub = readFileSync(join(clientRoot, 'pages/api/premium-fakeoverlay/ping.ts'), 'utf8');
    expect(stub).toContain(`export { default } from '${PKG_NAME}/api/ping'`);

    expect(existsSync(join(clientRoot, 'server/premium-generated/fakeoverlay.ts'))).toBe(true);
  });
});
