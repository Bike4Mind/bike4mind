// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./generate-premium-glue.mjs', import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT, 'utf8');

const GENERATED = 'apps/client/app/premium-generated';
const LLM_TOOLS = 'packages/server-utils/src/premium-generated/premiumLlmTools.generated.ts';
const LS_KEYS = `${GENERATED}/premiumLocalStorageKeys.generated.ts`;
const ROUTES = `${GENERATED}/premiumRoutes.generated.ts`;
const API_STUB = 'apps/client/pages/api/premium-fx/ping.ts';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

type Fixture = { name: string; dir: string; contributions?: Record<string, unknown>; linked?: boolean };

// Copies the script into a scratch tree so REPO_ROOT resolves there, never in the real checkout.
const makeTree = (opts: { premiumDir: boolean; packages?: Fixture[] }): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-glue-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'apps/client/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/client/scripts/generate-premium-glue.mjs'), SCRIPT_SOURCE);
  if (opts.premiumDir) fs.mkdirSync(path.join(root, 'packages/premium'), { recursive: true });
  for (const pkg of opts.packages ?? []) {
    const dir = path.join(root, 'packages/premium', pkg.dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/ping.ts'), 'export default () => {};\n');
    fs.writeFileSync(path.join(dir, 'src/tools.ts'), 'export const tools = {};\n');
    // The server-utils glue imports an overlay by its declared exports path, not by package name.
    const manifest: Record<string, unknown> = { name: pkg.name, exports: { './tools': './src/tools.ts' } };
    if (pkg.contributions) manifest.b4mContributions = pkg.contributions;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    if (pkg.linked !== false) {
      const link = path.join(root, 'node_modules', ...pkg.name.split('/'));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(dir, link, 'dir');
    }
  }
  return root;
};

const run = (root: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [path.join(root, 'apps/client/scripts/generate-premium-glue.mjs')], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, CI: '', ...env },
  });

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));

describe('generate-premium-glue.mjs', () => {
  describe('no overlays present', () => {
    it.each([
      ['packages/premium is absent', { premiumDir: false }],
      ['packages/premium is empty', { premiumDir: true }],
    ])('emits the empty forms when %s', (_label, opts) => {
      const root = makeTree(opts);
      const result = run(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('found 0 premium package(s): (none)');
      expect(read(root, LLM_TOOLS)).toContain('premiumLlmTools: Record<string, ToolDefinition> = {};');
      expect(read(root, LS_KEYS)).toContain('[]');
      expect(exists(root, 'apps/client/pages/api')).toBe(false);
    });
  });

  describe('packages without contributions', () => {
    it('ignores a package.json with no b4mContributions block', () => {
      const root = makeTree({ premiumDir: true, packages: [{ name: '@fixture/plain', dir: 'plain' }] });
      const result = run(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('found 0 premium package(s)');
    });

    it('skips a directory whose package.json is malformed', () => {
      const root = makeTree({ premiumDir: true });
      fs.mkdirSync(path.join(root, 'packages/premium/broken'), { recursive: true });
      fs.writeFileSync(path.join(root, 'packages/premium/broken/package.json'), '{ not json');
      const result = run(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('found 0 premium package(s)');
    });

    it('treats an empty contributions block and empty arrays as the empty forms', () => {
      const root = makeTree({
        premiumDir: true,
        packages: [
          {
            name: '@fixture/fx',
            dir: 'fx',
            contributions: { apiRouteStubs: [], serverHandlerStubs: [], localStorageKeyPrefixes: [] },
          },
        ],
      });
      const result = run(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('found 1 premium package(s): @fixture/fx');
      expect(read(root, LLM_TOOLS)).toContain('= {};');
      expect(read(root, LS_KEYS)).toContain('[]');
      expect(exists(root, API_STUB)).toBe(false);
    });
  });

  describe('fixture overlay', () => {
    const contributions = {
      apiRouteStubs: [{ generatedPath: 'pages/api/premium-fx/ping.ts', exportFrom: '@fixture/fx/api/ping' }],
      llmToolsExport: '@fixture/fx/tools',
      localStorageKeyPrefixes: ['fx:'],
    };

    it('wires a linked package into the route, tool and key glue', () => {
      const root = makeTree({ premiumDir: true, packages: [{ name: '@fixture/fx', dir: 'fx', contributions }] });
      const result = run(root);

      expect(result.status).toBe(0);
      expect(read(root, API_STUB)).toContain("export { default } from '@fixture/fx/api/ping';");
      expect(read(root, LLM_TOOLS)).toContain("from '../../../premium/fx/src/tools'");
      expect(read(root, LS_KEYS)).toContain("'fx:'");
    });

    it('emits the absent form with a warning when the package is not linked', () => {
      const root = makeTree({
        premiumDir: true,
        packages: [{ name: '@fixture/fx', dir: 'fx', contributions, linked: false }],
      });
      const result = run(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('is not resolvable from apps/client');
      expect(exists(root, API_STUB)).toBe(false);
      expect(read(root, LLM_TOOLS)).toContain('= {};');
      expect(read(root, LS_KEYS)).toContain("'fx:'");
    });

    it('fails in CI when a hydrated package is not linked', () => {
      const root = makeTree({
        premiumDir: true,
        packages: [{ name: '@fixture/fx', dir: 'fx', contributions, linked: false }],
      });
      const result = run(root, { CI: 'true' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('refusing to emit absent glue');
    });

    it('rejects a generatedPath that escapes pages/api/premium-*', () => {
      const root = makeTree({
        premiumDir: true,
        packages: [
          {
            name: '@fixture/fx',
            dir: 'fx',
            contributions: {
              apiRouteStubs: [
                { generatedPath: 'pages/api/premium-fx/../../evil.ts', exportFrom: '@fixture/fx/api/ping' },
              ],
            },
          },
        ],
      });
      const result = run(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unsafe generatedPath');
    });

    it('rejects a non-array localStorageKeyPrefixes', () => {
      const root = makeTree({
        premiumDir: true,
        packages: [{ name: '@fixture/fx', dir: 'fx', contributions: { localStorageKeyPrefixes: 'fx:' } }],
      });
      const result = run(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expected an array of key prefixes');
    });

    it('removes stale generated stubs once the overlay is gone', () => {
      const root = makeTree({ premiumDir: true, packages: [{ name: '@fixture/fx', dir: 'fx', contributions }] });
      expect(run(root).status).toBe(0);
      expect(exists(root, API_STUB)).toBe(true);

      fs.rmSync(path.join(root, 'packages/premium/fx'), { recursive: true });
      fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
      expect(run(root).status).toBe(0);
      expect(exists(root, API_STUB)).toBe(false);
      expect(read(root, LLM_TOOLS)).not.toContain('premium/fx/src/tools');
      expect(read(root, LS_KEYS)).not.toContain("'fx:'");
      expect(read(root, ROUTES)).toContain('PremiumRouteDescriptor[] = [];');
    });
  });
});
