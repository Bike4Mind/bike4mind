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
  findLoadFailureCode,
  describeLoadError,
  classifyLoadResult,
  summarizeWarnings,
  parseChildReport,
} from './check-api-routes-cjs-require.mjs';

const SCRIPT = fileURLToPath(new URL('./check-api-routes-cjs-require.mjs', import.meta.url));

const SELF_HOST_CONFIG_MISSING =
  'Self-host config missing: environment variable "MONGODB_URI" is not set. ' +
  'Add it to your .env (see .env.selfhost.example).';

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
  write(
    root,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: '11.0.0', type: 'module', main: 'index.js' })
  );
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
    expect(packageNameFromPath('/app/node_modules/.pnpm/@scope+esm@1.0.0/node_modules/@scope/esm/index.js')).toBe(
      '@scope/esm'
    );
    expect(packageNameFromPath('/app/node_modules/@scope/pkg/index.js')).toBe('@scope/pkg');
  });

  it('strips the hash Turbopack appends to an externalized module directory', () => {
    expect(packageNameFromPath('/app/apps/client/.next/node_modules/sanitize-html-edcbf62180965ef2/index.js')).toBe(
      'sanitize-html'
    );
    expect(packageNameFromPath('/app/apps/client/.next/node_modules/@scope/pkg-0123456789abcdef/index.js')).toBe(
      '@scope/pkg'
    );
  });

  it('returns null when there is no node_modules boundary', () => {
    expect(packageNameFromPath('/tmp/local/helper.js')).toBeNull();
  });
});

describe('findLoadFailureCode', () => {
  it.each([...['ERR_REQUIRE_ESM', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']])(
    'reads %s off error.code',
    code => {
      expect(findLoadFailureCode({ code, message: '' })).toBe(code);
    }
  );

  it('reads the code out of Turbopack external-loader wrapper that has no error.code', () => {
    const message =
      'Failed to load external module sanitize-html-edcbf62180965ef2: Error [ERR_REQUIRE_ESM]: ' +
      'require() of ES Module /x/htmlparser2/dist/index.js from /x/sanitize-html/index.js not supported.';
    expect(findLoadFailureCode({ code: undefined, message })).toBe('ERR_REQUIRE_ESM');
  });

  it('reads a bare "Cannot find module" with no code', () => {
    expect(findLoadFailureCode({ message: "Cannot find module 'left-pad'\nRequire stack:\n- /x/a.js" })).toBe(
      'MODULE_NOT_FOUND'
    );
  });

  it('returns null for a non-resolution error', () => {
    expect(findLoadFailureCode({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBeNull();
    expect(findLoadFailureCode({ message: 'Error: boom' })).toBeNull();
    expect(findLoadFailureCode()).toBeNull();
  });
});

describe('describeLoadError', () => {
  it('names the ESM package and its requirer from a real Node ERR_REQUIRE_ESM message', () => {
    const message =
      'require() of ES Module /app/node_modules/.pnpm/htmlparser2@11.0.0/node_modules/htmlparser2/dist/esm/index.js ' +
      'from /app/node_modules/.pnpm/sanitize-html@2.17.0/node_modules/sanitize-html/index.js not supported.\n' +
      'Instead change the require of /app/node_modules/.pnpm/htmlparser2@11.0.0/node_modules/htmlparser2/dist/esm/index.js ' +
      'in /app/node_modules/.pnpm/sanitize-html@2.17.0/node_modules/sanitize-html/index.js to a dynamic import() ' +
      'which is available in all CommonJS modules.';

    expect(describeLoadError(message)).toEqual({ missingPackage: 'htmlparser2', requiredFrom: 'sanitize-html' });
  });

  it('names the package through Turbopack wrapping a failed external load', () => {
    const message =
      'Failed to load external module sanitize-html-edcbf62180965ef2: Error [ERR_REQUIRE_ESM]: ' +
      'require() of ES Module /app/apps/client/.next/standalone/node_modules/.pnpm/htmlparser2@12.0.0/node_modules/htmlparser2/dist/index.js ' +
      'from /app/apps/client/.next/standalone/node_modules/.pnpm/sanitize-html@2.17.7/node_modules/sanitize-html/index.js not supported.\n' +
      'Instead change the require of /app/.../htmlparser2/dist/index.js in /app/.../sanitize-html/index.js to a dynamic import().';

    expect(describeLoadError(message)).toEqual({ missingPackage: 'htmlparser2', requiredFrom: 'sanitize-html' });
  });

  it('names a missing module and its requirer from a Cannot find module + Require stack shape', () => {
    const message =
      "Cannot find module 'htmlparser2'\n" +
      'Require stack:\n' +
      '- /app/node_modules/.pnpm/sanitize-html@2.17.7/node_modules/sanitize-html/index.js\n' +
      '- /app/apps/client/.next/server/pages/api/feedback.js';

    expect(describeLoadError(message)).toEqual({ missingPackage: 'htmlparser2', requiredFrom: 'sanitize-html' });
  });

  it('names a package missing via an ESM "Cannot find package ... imported from" message', () => {
    const message = "Cannot find package 'not-installed-pkg' imported from /app/apps/client/.next/server/chunks/x.js";
    // The importer has no node_modules boundary, so the raw path is the best label available.
    expect(describeLoadError(message)).toEqual({
      missingPackage: 'not-installed-pkg',
      requiredFrom: '/app/apps/client/.next/server/chunks/x.js',
    });
  });

  it('degrades to nulls on a message shape it does not recognise, without throwing', () => {
    expect(describeLoadError('some other failure')).toEqual({ missingPackage: null, requiredFrom: null });
    expect(describeLoadError(undefined)).toEqual({ missingPackage: null, requiredFrom: null });
  });
});

describe('classifyLoadResult', () => {
  it.each([...['ERR_REQUIRE_ESM', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']])(
    'fails on the resolution code %s',
    code => {
      expect(classifyLoadResult({ code, message: `Error [${code}]: ...` })).toBe('fail');
    }
  );

  it('fails when Turbopack wraps the code in the message but leaves error.code empty', () => {
    expect(
      classifyLoadResult({
        code: undefined,
        message:
          'Failed to load external module sanitize-html-abc: Error [ERR_REQUIRE_ESM]: require() of ES Module ...',
      })
    ).toBe('fail');
  });

  it('fails an env-masked route, since it never reached its own requires', () => {
    expect(classifyLoadResult({ message: SELF_HOST_CONFIG_MISSING })).toBe('fail');
  });

  it.each([
    ['a timeout that still reported', { timedOut: true, message: 'Error: slow route' }],
    ['a connection error', { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:27017' }],
    ['a generic load error', { message: 'Error: boom' }],
  ])('warns on %s instead of failing the build', (_label, result) => {
    expect(classifyLoadResult(result)).toBe('warn');
  });

  it('fails an unreported child, because the route was never probed', () => {
    expect(classifyLoadResult({ unreported: true, message: 'child exited with code null (signal SIGKILL)' })).toBe(
      'fail'
    );
    expect(classifyLoadResult({ unreported: true, timedOut: true })).toBe('fail');
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
        { result: { code: 'ECONNREFUSED' } },
        { result: { code: 'ECONNREFUSED' } },
        { result: { message: 'Error: no database\n  at x' } },
      ])
    ).toEqual([
      ['ECONNREFUSED', 2],
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
  // The standalone root mirrors the monorepo root: traced deps live in <root>/node_modules,
  // route modules in <root>/apps/client/.next/server/pages/api. The probe copies <root> outside
  // the builder before loading anything.
  const NEXT = 'apps/client/.next';
  const run = (standaloneRoot: string, nextDirRel: string = NEXT) =>
    spawnSync(process.execPath, [SCRIPT, standaloneRoot, nextDirRel], { encoding: 'utf8' });
  const writeRoute = (root: string, routeRel: string, contents: string): void =>
    write(root, path.join(NEXT, routeRel), contents);

  it('passes a tree whose routes load, reporting the route count and no warnings', () => {
    const dir = makeTempDir();
    writeCjsPackage(dir, 'cjs-helper');
    // The route logs at load, so the report has to survive stdout noise from the route itself.
    writeRoute(
      dir,
      'server/pages/api/good.js',
      "console.log('route noise at load');\nmodule.exports = require('cjs-helper');\n"
    );
    writeRoute(dir, 'server/pages/api/help/index.js', 'module.exports = {};\n');

    const result = run(dir);
    expect(result.stderr).not.toContain('cannot load');
    expect(result.stderr).not.toContain('did not load cleanly');
    expect(result.stdout).toContain('2 routes probed, 0 failed to load');
    expect(result.status).toBe(0);
  });

  it('fails a tree with an ESM-only require, naming the route and the package', () => {
    const dir = makeTempDir();
    writeEsmPackage(dir, 'esm-only');
    writeRoute(dir, 'server/pages/api/bad.js', "module.exports = require('esm-only');\n");

    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/bad');
    expect(result.stderr).toContain('esm-only');
  });

  it('fails a tree with an unresolvable require, naming the route and the missing package', () => {
    const dir = makeTempDir();
    writeRoute(dir, 'server/pages/api/missing.js', "module.exports = require('not-installed-pkg');\n");

    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/missing');
    expect(result.stderr).toContain('not-installed-pkg');
  });

  it('fails a tree with an env-masked route, pointing at the self-host template', () => {
    const dir = makeTempDir();
    writeRoute(dir, 'server/pages/api/masked.js', `throw new Error(${JSON.stringify(SELF_HOST_CONFIG_MISSING)});\n`);

    const result = run(dir);
    expect(result.status).toBe(1);
    // The per-route line, not just the generic remediation paragraph that always prints both.
    expect(result.stderr).toContain('/api/masked [Self-host config missing - add the key to .env.selfhost.example]');
  });

  it('fails a route whose awaited async exports reject after the settle window', () => {
    const dir = makeTempDir();
    // Turbopack emits routes as async modules; the promise rejects only after the route's
    // awaited imports resolve, well past any fixed timer started at require().
    writeRoute(
      dir,
      'server/pages/api/late.js',
      'module.exports = (async () => {\n' +
        '  await new Promise((r) => setTimeout(r, 150));\n' +
        "  throw new Error('Failed to load external module esm-late-deadbeef: Error [ERR_REQUIRE_ESM]: " +
        "require() of ES Module /x/node_modules/esm-late/index.js from /x/node_modules/sanitize-html/index.js not supported.');\n" +
        '})();\n'
    );

    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/late');
    expect(result.stderr).toContain('esm-late');
  });

  it('warns, rather than fails, a route that throws a non-resolution error', () => {
    const dir = makeTempDir();
    writeRoute(dir, 'server/pages/api/boom.js', "throw new Error('probe fixture blew up');\n");

    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('1x probe fixture blew up');
    expect(result.stdout).toContain('1 routes probed, 0 failed to load');
  });

  it('fails a route whose child exits without reporting, since it was never probed', () => {
    const dir = makeTempDir();
    writeRoute(dir, 'server/pages/api/quiet.js', 'process.exit(0);\n');

    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/quiet');
  });

  it('resolves a package traced into the standalone tree', () => {
    const standaloneRoot = makeTempDir();
    writeCjsPackage(standaloneRoot, 'traced-helper');
    writeRoute(standaloneRoot, 'server/pages/api/traced.js', "module.exports = require('traced-helper');\n");

    const result = run(standaloneRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 routes probed, 0 failed to load');
  });

  it('does not resolve a package that exists only in a builder ancestor above the standalone root', () => {
    const builderRoot = makeTempDir();
    writeCjsPackage(builderRoot, 'ancestor-only');
    const standaloneRoot = path.join(builderRoot, 'apps/client/.next/standalone');
    writeRoute(standaloneRoot, 'server/pages/api/isolated.js', "module.exports = require('ancestor-only');\n");

    // In place, Node's ancestor walk finds builderRoot/node_modules. The probe's copy must not.
    const result = run(standaloneRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/isolated');
    expect(result.stderr).toContain('ancestor-only');
  });

  it('fails a tree with no routes, so a moved build root cannot read as all clear', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, NEXT, 'server/pages/api'), { recursive: true });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no API route modules');
  });
});
