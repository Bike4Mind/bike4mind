// @vitest-environment node
import { describe, expect, it, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs build script, intentionally not part of the TS program
import {
  listApiRouteModules,
  routePathForModule,
  packageNameFromPath,
  describeEsmError,
  classifyLoadResult,
  summarizeWarnings,
  parseChildReport,
} from './check-api-routes-cjs-require.mjs';

const SCRIPT = fileURLToPath(new URL('./check-api-routes-cjs-require.mjs', import.meta.url));

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-cjs-require-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const write = (root: string, rel: string, contents: string): void => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
};

const writeCjsPackage = (root: string, name: string): void => {
  write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  write(root, `node_modules/${name}/index.js`, 'module.exports = {};\n');
};

const writeEsmPackage = (root: string, name: string): void => {
  write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '11.0.0', type: 'module', main: 'index.js' }));
  write(root, `node_modules/${name}/index.js`, 'export const x = 1;\n');
};

describe('listApiRouteModules', () => {
  it('finds nested pages/api modules and skips non-route sidecars, tests and non-api pages', () => {
    const dir = makeTempDir();
    write(dir, 'server/pages/api/feedback.js', '');
    write(dir, 'server/pages/api/help/index.js', '');
    write(dir, 'server/pages/api/admin/email/whats-new-content.js', '');
    write(dir, 'server/pages/api/feedback.js.nft.json', '');
    write(dir, 'server/pages/api/feedback.js.map', '');
    write(dir, 'server/pages/api/dashboard.test.js', '');
    write(dir, 'server/pages/api/__tests__/internal.js', '');
    write(dir, 'server/pages/dashboard.js', '');

    expect(listApiRouteModules(dir)).toEqual([
      'server/pages/api/admin/email/whats-new-content.js',
      'server/pages/api/feedback.js',
      'server/pages/api/help/index.js',
    ]);
  });

  it('returns empty for a tree with no compiled api directory', () => {
    expect(listApiRouteModules(makeTempDir())).toEqual([]);
  });
});

describe('routePathForModule', () => {
  it.each([
    ['server/pages/api/feedback.js', '/api/feedback'],
    ['server/pages/api/help/index.js', '/api/help'],
    ['server/pages/api/agents/[id]/missions.js', '/api/agents/[id]/missions'],
  ])('maps %s to %s', (rel, expected) => {
    expect(routePathForModule(rel)).toBe(expected);
  });
});

describe('packageNameFromPath', () => {
  it('takes the package after the last node_modules, so a pnpm path names the package not .pnpm', () => {
    expect(
      packageNameFromPath('/app/node_modules/.pnpm/htmlparser2@11.0.0/node_modules/htmlparser2/dist/esm/index.js')
    ).toBe('htmlparser2');
  });

  it('keeps a scoped package whole', () => {
    expect(packageNameFromPath('/app/node_modules/.pnpm/@scope+esm@1.0.0/node_modules/@scope/esm/index.js')).toBe('@scope/esm');
    expect(packageNameFromPath('/app/node_modules/@scope/pkg/index.js')).toBe('@scope/pkg');
  });

  it('returns null when there is no node_modules boundary', () => {
    expect(packageNameFromPath('/tmp/local/helper.js')).toBeNull();
  });
});

describe('describeEsmError', () => {
  it('names the ESM package and its requirer from a real Node 22 ERR_REQUIRE_ESM message', () => {
    const message =
      'require() of ES Module /app/node_modules/.pnpm/htmlparser2@11.0.0/node_modules/htmlparser2/dist/esm/index.js ' +
      'from /app/node_modules/.pnpm/sanitize-html@2.17.0/node_modules/sanitize-html/index.js not supported.\n' +
      'Instead change the require of /app/node_modules/.pnpm/htmlparser2@11.0.0/node_modules/htmlparser2/dist/esm/index.js ' +
      'in /app/node_modules/.pnpm/sanitize-html@2.17.0/node_modules/sanitize-html/index.js to a dynamic import() ' +
      'which is available in all CommonJS modules.';

    expect(describeEsmError(message)).toEqual({ esmPackage: 'htmlparser2', requiredFrom: 'sanitize-html' });
  });

  it('degrades to nulls on a message shape it does not recognise, without throwing', () => {
    expect(describeEsmError('some other failure')).toEqual({ esmPackage: null, requiredFrom: null });
    expect(describeEsmError(undefined)).toEqual({ esmPackage: null, requiredFrom: null });
  });
});

describe('classifyLoadResult', () => {
  it('fails on ERR_REQUIRE_ESM only', () => {
    expect(classifyLoadResult({ code: 'ERR_REQUIRE_ESM', message: 'require() of ES Module ...' })).toBe('fail');
  });

  it.each([
    ['a clean load', {}],
    ['a timeout', { timedOut: true }],
    ['a missing module', { code: 'MODULE_NOT_FOUND', message: "Cannot find module 'x'" }],
    ['a generic load error', { message: 'Error: boom' }],
  ])('warns or passes %s instead of failing the build', (_label, result) => {
    expect(classifyLoadResult(result)).not.toBe('fail');
  });

  it('passes only a clean load', () => {
    expect(classifyLoadResult({})).toBe('pass');
    expect(classifyLoadResult()).toBe('pass');
  });
});

describe('summarizeWarnings', () => {
  it('groups by code or first message line, most frequent first', () => {
    expect(
      summarizeWarnings([
        { result: { code: 'MODULE_NOT_FOUND' } },
        { result: { code: 'MODULE_NOT_FOUND' } },
        { result: { message: 'Error: no database\n  at x' } },
      ])
    ).toEqual([
      ['MODULE_NOT_FOUND', 2],
      ['Error: no database', 1],
    ]);
  });
});

describe('parseChildReport', () => {
  it('reads the last tagged report line and ignores route stdout noise', () => {
    const stdout = 'loading route\n@@API_ROUTE_PROBE@@{"loaded":true}\n';
    expect(parseChildReport(stdout)).toEqual({ loaded: true });
  });

  it('returns undefined when no report marker is present', () => {
    expect(parseChildReport('just noise\n')).toBeUndefined();
  });
});

describe('CLI', () => {
  const run = (nextDir: string) => spawnSync(process.execPath, [SCRIPT, nextDir], { encoding: 'utf8' });

  it('passes a tree whose routes load, reporting the route count', () => {
    const dir = makeTempDir();
    writeCjsPackage(dir, 'cjs-helper');
    // The route logs at load, so the report has to survive stdout noise from the route itself.
    write(dir, 'server/pages/api/good.js', "console.log('route noise at load');\nmodule.exports = require('cjs-helper');\n");
    write(dir, 'server/pages/api/help/index.js', 'module.exports = {};\n');

    const result = run(dir);
    expect(result.stderr).not.toContain('ERR_REQUIRE_ESM');
    expect(result.stdout).toContain('2 routes probed, 0 ERR_REQUIRE_ESM');
    expect(result.status).toBe(0);
  });

  it('fails a tree with an ESM-only require, naming the route and the package', () => {
    const dir = makeTempDir();
    writeEsmPackage(dir, 'esm-only');
    write(dir, 'server/pages/api/bad.js', "module.exports = require('esm-only');\n");

    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/bad');
    expect(result.stderr).toContain('esm-only');
  });

  it('fails a tree with no routes, so a moved build root cannot read as all clear', () => {
    const dir = makeTempDir();
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no API route modules');
  });
});
