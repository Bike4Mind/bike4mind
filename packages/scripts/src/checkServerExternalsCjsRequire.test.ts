import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards the failure class behind the /api/feedback outage: a package that Node resolves to
 * ESM at runtime, require()d from the CommonJS API-route bundle, throws ERR_REQUIRE_ESM at
 * MODULE LOAD. No handler and no auth middleware runs, so the caller gets a framework HTML
 * 500 instead of the JSON envelope every sibling route returns - and the route's unit tests
 * stay green, because vitest imports the source as ESM and never exercises a real require.
 *
 * Scope is deliberately narrow, and the narrowing is the load-bearing part. An earlier
 * attempt checked every external package reachable from pages/api/**, which is unsound:
 * uuid, p-limit, file-type, openid-client, @octokit/rest and several @bike4mind/* packages
 * are all ESM-only and all reachable from a route, yet production is fine because webpack
 * bundles them. Reachability says nothing about whether a real require() ever happens. Only
 * these two groups are require()d for real:
 *
 *   - serverExternalPackages, read from next.config.mjs rather than duplicated here so the
 *     list cannot drift. Next excludes these from the bundle by definition, so Node loads
 *     them from node_modules at runtime.
 *   - RUNTIME_REQUIRED below: packages observed to reach a real require() in a deployed
 *     stack trace despite not being externals. Add one only with that evidence.
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
 * sanitize-html is bundled, not external, yet its require('htmlparser2') reached Node at
 * runtime in the deployed stack trace. It is held here because the pnpm override pinning
 * htmlparser2 to the dual-published v10 is otherwise load-bearing and silently removable:
 * nothing in the repo fails when it is dropped until a deployed route 500s again.
 */
const RUNTIME_REQUIRED = ['sanitize-html'];

/**
 * Packages whose declaring workspace package is not apps/client. Under pnpm's strict tree
 * they are unresolvable from the app but resolve fine from their owner, so the probe anchors
 * each one at the workspace package.json that declares it.
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

const readServerExternalPackages = (): string[] => {
  const source = fs.readFileSync(NEXT_CONFIG, 'utf8');
  const block = /serverExternalPackages:\s*\[([\s\S]*?)\]/.exec(source);
  // A rename or reshape of the option must fail loudly rather than silently checking nothing.
  expect(block, `could not find serverExternalPackages in ${NEXT_CONFIG}`).not.toBeNull();
  return [...block![1].matchAll(/'([^']+)'/g)].map(m => m[1]);
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

describe('packages require()d at runtime by the API routes load as CommonJS', () => {
  it('resolves every one of them without ERR_REQUIRE_ESM', () => {
    const packages = [...readServerExternalPackages(), ...RUNTIME_REQUIRED];
    expect(packages.length).toBeGreaterThan(0);

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
