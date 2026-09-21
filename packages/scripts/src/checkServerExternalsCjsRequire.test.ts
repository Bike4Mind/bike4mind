import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the failure class behind the /api/feedback outage: a package that Node resolves to
 * ESM at runtime, require()d from the CommonJS API-route bundle, throws ERR_REQUIRE_ESM at
 * MODULE LOAD. No handler and no auth middleware runs, so the caller gets a framework HTML
 * 500 instead of the JSON envelope every sibling route returns - and the route's unit tests
 * stay green, because vitest imports the source as ESM and never exercises a real require.
 *
 * Only packages that reach a real require() at runtime are checked, and that narrowing is
 * load-bearing: reachability from pages/api/** is not the same property, since most ESM-only
 * packages a route can reach are bundled by webpack and never require()d. The sound general
 * form - require each route's BUILT module - needs a `next build` artifact this repo's CI
 * does not produce; see #2982 rather than rebuilding the reachability version.
 *
 * The probe runs under --no-experimental-require-module, which is how the original failure
 * was reproduced. Passing without require(esm) is the stronger guarantee: a dual-published
 * package resolves its "require" condition to a CommonJS file and cannot throw under any
 * Node or bundler, rather than depending on require(esm) engaging in whatever context the
 * route is loaded from.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NEXT_CONFIG = path.join(REPO_ROOT, 'apps/client/next.config.mjs');

/**
 * sanitize-html sits in transpilePackages (pinned by checkSanitizeHtmlTranspile.test.ts), not in
 * serverExternalPackages, so the imported list below does not cover it. It is held here because
 * its require('htmlparser2') reached Node in the deployed stack trace, which makes this probe the
 * only require()-level pin on the htmlparser2 override at root package.json: drop that override
 * and nothing in the repo fails until a deployed route 500s again. Add an entry only with the
 * same kind of evidence.
 */
const RUNTIME_REQUIRED = ['sanitize-html'];

/**
 * Resolves each package from the workspace package.json that declares it. Under pnpm's strict
 * tree a package declared by a core workspace is unresolvable from apps/client, so anchoring at
 * the declaring owner is what makes the require() run at all - the check is therefore "loads as
 * CommonJS", not "loads as CommonJS from apps/client".
 */
const findAnchor = (pkg: string): string => {
  const candidates = execFileSync(
    'bash',
    ['-c', `grep -rl '"${pkg}"' --include=package.json apps b4m-core packages 2>/dev/null || true`],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .map(p => path.join(REPO_ROOT, path.dirname(p)));
  const client = path.join(REPO_ROOT, 'apps/client');
  return candidates.includes(client) ? client : (candidates[0] ?? client);
};

type ProbeResult = { pkg: string; code?: string };

const probe = (entries: { pkg: string; anchor: string }[]): ProbeResult[] => {
  const script = `
    const { createRequire } = require('node:module');
    const path = require('node:path');
    const out = [];
    for (const { pkg, anchor } of JSON.parse(process.argv[1])) {
      try { createRequire(path.join(anchor, 'index.js'))(pkg); }
      catch (error) { out.push({ pkg, code: error.code }); }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--no-experimental-require-module', '-e', script, JSON.stringify(entries)],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(stdout) as ProbeResult[];
};

describe('packages require()d at runtime load as CommonJS', () => {
  let serverExternalPackages: string[];

  // Imported rather than text-matched so the RESOLVED value is what gets checked; a regex over
  // the source passes on `serverExternalPackages: []` just as happily.
  beforeAll(async () => {
    const config = await import(NEXT_CONFIG);
    serverExternalPackages = config.default.serverExternalPackages;
  });

  it('reads a non-empty serverExternalPackages out of next.config.mjs', () => {
    // Guards the guard: asserted in isolation because RUNTIME_REQUIRED alone would otherwise
    // keep the probe below green while the externals list went entirely unchecked.
    expect(
      serverExternalPackages,
      `no serverExternalPackages in ${NEXT_CONFIG} - the probe below would check nothing`
    ).not.toHaveLength(0);
  });

  it('resolves every one of them without ERR_REQUIRE_ESM', () => {
    const packages = [...serverExternalPackages, ...RUNTIME_REQUIRED];
    const failures = probe(packages.map(pkg => ({ pkg, anchor: findAnchor(pkg) })));

    expect(
      failures,
      failures.length === 0
        ? ''
        : [
            'These packages cannot be require()d from CommonJS, so an API route that loads one',
            'returns a framework HTML 500 before any handler or auth middleware runs:',
            '',
            ...failures.map(f => `  ${f.pkg} (${f.code})`),
            '',
            'ERR_REQUIRE_ESM: the package (or a dependency) resolves to ESM under require. Pin or',
            'override it to a dual-published version whose "exports" carries a require condition,',
            'or add it to transpilePackages in apps/client/next.config.mjs so webpack inlines it.',
            'MODULE_NOT_FOUND: the package is named in serverExternalPackages but is not a',
            'dependency of any workspace package, so nothing would resolve it at runtime either.',
          ].join('\n')
    ).toEqual([]);
  }, 60_000);
});
