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
 * typecheck/build with cannot-find-module errors), while the relative-import glue (infra,
 * migrations and the shared glue in packages/server-utils) keeps the PRESENT form: it imports
 * overlay source by path and needs no link.
 *
 * Runs the real script inside a sandbox tree, since its paths derive from its own
 * location: sandbox/apps/client/scripts/ next to sandbox/packages/premium/.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const PKG_NAME = '@bike4mind/premium-fakeoverlay';
const SHARED_GLUE = 'packages/server-utils/src/premium-generated';
// Overlay source as the shared glue imports it, relative to SHARED_GLUE.
const OVERLAY_SRC = '../../../premium/fakeoverlay/src';
// Generated into SHARED_GLUE, and generated under apps/client before that.
const SHARED_GLUE_FORMER_PATHS = [
  'server/premium-generated/premiumLlmTools.generated.ts',
  'server/premium-generated/premiumSystemPrompts.generated.ts',
  'server/premium-generated/premiumAgentExtensions.generated.ts',
  'server/premium-generated/premiumWorkspaceSessionSettings.generated.ts',
  'server/premium-generated/premiumWorkspaceDeniedTools.generated.ts',
  'app/premium-generated/premiumAdminSettings.generated.ts',
  'app/premium-generated/premiumEntitlementGrants.generated.ts',
  'app/premium-generated/premiumApiKeyScopes.generated.ts',
];

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

function readSharedGlue(name: string) {
  return readFileSync(join(sandbox, SHARED_GLUE, `${name}.generated.ts`), 'utf8');
}

// The five shared-glue modules that import the overlay must always name its source by relative
// path: no overlay is linked into packages/server-utils, so a bare specifier would not resolve.
function expectSharedGlueImportsOverlaySource() {
  const tools = readSharedGlue('premiumLlmTools');
  expect(tools).toContain(`import { llmTools as tools0 } from '${OVERLAY_SRC}/tools';`);

  const prompts = readSharedGlue('premiumSystemPrompts');
  expect(prompts).toContain(`import type { DefaultSystemPrompt } from '../utils/systemPrompts/defaults';`);
  expect(prompts).toContain(`import { systemPrompts as prompts0 } from '${OVERLAY_SRC}/prompts';`);

  const agentExtensions = readSharedGlue('premiumAgentExtensions');
  expect(agentExtensions).toContain(
    `import { agentExtensions as extensions0 } from '${OVERLAY_SRC}/agent-extensions';`
  );

  const adminSettings = readSharedGlue('premiumAdminSettings');
  expect(adminSettings).toContain(`import { adminSettings as settings0 } from '${OVERLAY_SRC}/admin-settings';`);

  const sessionSettings = readSharedGlue('premiumWorkspaceSessionSettings');
  expect(sessionSettings).toContain(
    `import { workspaceSessionSettings as settings0 } from '${OVERLAY_SRC}/session-settings';`
  );
  expect(sessionSettings).toContain('"opti": settings0,');

  for (const glue of [tools, prompts, agentExtensions, adminSettings, sessionSettings]) {
    expect(glue).not.toContain(PKG_NAME);
  }
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
        './tools': './src/tools.ts',
        './prompts': './src/prompts.ts',
        './agent-extensions': './src/agent-extensions.ts',
        './admin-settings': './src/admin-settings.ts',
        './session-settings': './src/session-settings.ts',
      },
      b4mContributions: {
        spaRoutesExport: `${PKG_NAME}/routes`,
        navItemsExport: `${PKG_NAME}/nav`,
        routeIndexingExport: `${PKG_NAME}/seo`,
        notebookSidenavExport: `${PKG_NAME}/sidenav`,
        replyAccessoryExport: `${PKG_NAME}/reply-accessory`,
        llmToolsExport: `${PKG_NAME}/tools`,
        systemPromptsExport: `${PKG_NAME}/prompts`,
        partnerSignupHooksExport: `${PKG_NAME}/signup-hooks`,
        agentExtensionsExport: `${PKG_NAME}/agent-extensions`,
        adminSettingsExport: `${PKG_NAME}/admin-settings`,
        workspaceSessionSettingsExport: { opti: `${PKG_NAME}/session-settings` },
        migrationsExport: `${PKG_NAME}/server/migrations`,
        apiRouteStubs: [{ generatedPath: 'pages/api/premium-fakeoverlay/ping.ts', exportFrom: `${PKG_NAME}/api/ping` }],
        serverHandlerStubs: [
          { generatedPath: 'server/premium-generated/fakeoverlay.ts', exportFrom: `${PKG_NAME}/handlers` },
        ],
        infra: true,
        localStorageKeyPrefixes: ['fakeoverlay-'],
      },
    })
  );
  writeFileSync(join(overlayDir, 'src/infra.ts'), 'export function contributeInfra() {}\n');
  mkdirSync(join(overlayDir, 'src/server'), { recursive: true });
  writeFileSync(join(overlayDir, 'src/server/migrations.ts'), 'export const migrations = [];\n');

  // Left behind by codegen from before the shared glue moved into packages/server-utils.
  for (const former of SHARED_GLUE_FORMER_PATHS) {
    mkdirSync(join(clientRoot, former, '..'), { recursive: true });
    writeFileSync(join(clientRoot, former), 'export {};\n');
  }

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

    const signupHooks = readFileSync(
      join(clientRoot, 'server/premium-generated/premiumPartnerSignupHooks.generated.ts'),
      'utf8'
    );
    expect(signupHooks).not.toContain(PKG_NAME);
    expect(signupHooks).toContain('premiumPartnerSignupHooks: PartnerSignupHook[] = []');

    const nav = readFileSync(join(clientRoot, 'app/premium-generated/premiumNavItems.generated.ts'), 'utf8');
    expect(nav).not.toContain(PKG_NAME);
    expect(nav).toContain('premiumNavItems: PremiumNavDescriptor[] = []');

    const sidenav = readFileSync(
      join(clientRoot, 'app/premium-generated/premiumNotebookSidenavs.generated.ts'),
      'utf8'
    );
    expect(sidenav).not.toContain(PKG_NAME);
    expect(sidenav).toContain('premiumNotebookSidenavs: PremiumNotebookSidenavEntry[] = []');

    // PromptReplies imports this statically, so it must never name an unresolvable package.
    const accessories = readFileSync(
      join(clientRoot, 'app/premium-generated/premiumReplyAccessories.generated.ts'),
      'utf8'
    );
    expect(accessories).not.toContain(PKG_NAME);
    expect(accessories).toContain('premiumReplyAccessories: PremiumReplyAccessory[] = []');

    // robots.ts/sitemap.ts import this statically, so an unresolvable import here
    // would break the whole app's build, not just the overlay's crawler policy.
    const indexing = readFileSync(join(clientRoot, 'app/premium-generated/premiumRouteIndexing.generated.ts'), 'utf8');
    expect(indexing).not.toContain(PKG_NAME);
    expect(indexing).toContain('premiumRouteIndexing: PremiumRouteIndexing[] = []');

    expect(existsSync(join(clientRoot, 'pages/api/premium-fakeoverlay'))).toBe(false);
    expect(existsSync(join(clientRoot, 'server/premium-generated/fakeoverlay.ts'))).toBe(false);
  });

  it('still emits the PRESENT no-import + relative-import glue (they need no link)', () => {
    runCodegen();

    // Pure data lifted from package.json - it must never be demoted into the
    // linked-only group, or the sweep silently stops covering unlinked overlays.
    const lsKeys = readFileSync(join(clientRoot, 'app/premium-generated/premiumLocalStorageKeys.generated.ts'), 'utf8');
    expect(lsKeys).toContain(`'fakeoverlay-'`);

    const infra = readFileSync(join(sandbox, 'infra/premium-generated/fakeoverlay-infra.generated.ts'), 'utf8');
    expect(infra).toContain(`from '../../packages/premium/fakeoverlay/src/infra'`);

    const migrations = readFileSync(join(sandbox, 'packages/scripts/migrate/migrations/premium.generated.ts'), 'utf8');
    expect(migrations).toContain('premium/fakeoverlay/src/server/migrations');
    expect(migrations).not.toContain(PKG_NAME);

    expectSharedGlueImportsOverlaySource();
  });

  it('removes the shared glue from its former apps/client paths', () => {
    runCodegen();

    for (const former of SHARED_GLUE_FORMER_PATHS) {
      expect(existsSync(join(clientRoot, former)), former).toBe(false);
    }
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

    const sidenav = readFileSync(
      join(clientRoot, 'app/premium-generated/premiumNotebookSidenavs.generated.ts'),
      'utf8'
    );
    expect(sidenav).toContain(`import('${PKG_NAME}/sidenav')`);

    const accessories = readFileSync(
      join(clientRoot, 'app/premium-generated/premiumReplyAccessories.generated.ts'),
      'utf8'
    );
    expect(accessories).toContain(`import('${PKG_NAME}/reply-accessory')`);

    const indexing = readFileSync(join(clientRoot, 'app/premium-generated/premiumRouteIndexing.generated.ts'), 'utf8');
    expect(indexing).toContain(`import { routeIndexing as indexing0 } from '${PKG_NAME}/seo'`);

    expectSharedGlueImportsOverlaySource();

    const signupHooks = readFileSync(
      join(clientRoot, 'server/premium-generated/premiumPartnerSignupHooks.generated.ts'),
      'utf8'
    );
    expect(signupHooks).toContain(`import { partnerSignupHooks as hooks0 } from '${PKG_NAME}/signup-hooks'`);

    const stub = readFileSync(join(clientRoot, 'pages/api/premium-fakeoverlay/ping.ts'), 'utf8');
    expect(stub).toContain(`export { default } from '${PKG_NAME}/api/ping'`);

    expect(existsSync(join(clientRoot, 'server/premium-generated/fakeoverlay.ts'))).toBe(true);
  });
});

describe('a contributed export the overlay does not declare', () => {
  let packageJson: string;

  beforeAll(() => {
    linkOverlay();
    const path = join(sandbox, 'packages/premium/fakeoverlay/package.json');
    packageJson = readFileSync(path, 'utf8');
    const pkg = JSON.parse(packageJson);
    delete pkg.exports['./tools'];
    writeFileSync(path, JSON.stringify(pkg));
  });

  afterAll(() => {
    writeFileSync(join(sandbox, 'packages/premium/fakeoverlay/package.json'), packageJson);
  });

  it('fails codegen instead of dropping the import', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`cannot resolve llmToolsExport "${PKG_NAME}/tools"`);
  });
});
