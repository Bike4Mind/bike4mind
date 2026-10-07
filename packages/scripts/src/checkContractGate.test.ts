import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/check-contract-gate.sh.
 *
 * Each case builds a throwaway directory tree and runs the real script against it, so the
 * assertions cover the shipped shell rather than a reimplementation. Nothing here touches
 * the working repo. Mirrors the shape of checkNoSmartPunctuation.test.ts.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'check-contract-gate.sh');
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

/** A fresh sandbox with the minimal directory layout the script needs. */
function makeTree(): { dir: string; v1Dir: string; allowlist: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));
  sandboxes.push(dir);
  const v1Dir = path.join(dir, 'apps', 'client', 'pages', 'api', 'v1');
  fs.mkdirSync(v1Dir, { recursive: true });
  const allowlist = path.join(dir, 'scripts', 'contract-gate-allowlist.txt');
  fs.mkdirSync(path.dirname(allowlist), { recursive: true });
  fs.writeFileSync(allowlist, '# header-only\n', 'utf8');
  return { dir, v1Dir: v1Dir, allowlist };
}

function writeHandler(baseDir: string, rel: string, content: string): string {
  const full = path.join(baseDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  // Return the path as it appears relative to the sandbox dir
  return path.join('apps', 'client', 'pages', 'api', 'v1', rel);
}

/** A handler that violates the gate: baseApi with requiredScopes, no contract adapter. */
const VIOLATING = `
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] }).get((req, res) => res.json({}));
export default h;
`.trimStart();

/** Same, but using TypeScript generics -- the pattern the original regex missed. */
const VIOLATING_GENERIC = `
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi<Req, Res>({ requiredScopes: ['admin'] }).get((req, res) => res.json({}));
export default h;
`.trimStart();

/** A handler that uses nextRouteForContract -- exempt from the gate. */
const EXEMPT_CONTRACT = `
import { nextRouteForContract } from '@server/middlewares/nextRouteForContract';
export default nextRouteForContract(contract, async (req) => ({ data: null }));
`.trimStart();

/**
 * A handler that uses BOTH nextRouteForContract AND baseApi with requiredScopes.
 * This is the critical regression fixture: if the gate's exemption branch is removed,
 * this handler would be flagged even though it uses the contract adapter.
 */
const EXEMPT_DUAL = `
import { nextRouteForContract } from '@server/middlewares/nextRouteForContract';
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] });
export default nextRouteForContract(contract, async (req) => ({ data: null }));
`.trimStart();

/** A handler with baseApi but no requiredScopes -- not in scope for this gate. */
const CLEAN_NO_SCOPES = `
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({}).get((req, res) => res.json({}));
export default h;
`.trimStart();

function runGuard(dir: string, args: string[] = []) {
  const r = spawnSync(BASH, [GUARD, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-contract-gate.sh', () => {
  it('is present and executable', () => {
    expect(fs.existsSync(GUARD)).toBe(true);
    expect(fs.statSync(GUARD).mode & 0o111).toBeGreaterThan(0);
  });

  it('exits 0 and reports OK when there are no violations', () => {
    const { dir, v1Dir } = makeTree();
    writeHandler(v1Dir, 'clean.ts', EXEMPT_CONTRACT);
    const r = runGuard(dir, ['--error']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('exits 1 when the allowlist file is missing', () => {
    const { dir } = makeTree();
    fs.rmSync(path.join(dir, 'scripts', 'contract-gate-allowlist.txt'));
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR.*Allowlist not found/);
  });

  it('exits 1 when the API directory is missing', () => {
    const { dir } = makeTree();
    fs.rmSync(path.join(dir, 'apps'), { recursive: true });
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR.*API directory not found/);
  });

  it('exits 0 with a header-only allowlist and no violators', () => {
    const { dir } = makeTree();
    expect(runGuard(dir, ['--error']).status).toBe(0);
  });

  describe('contract-adapter exemption (critical regression)', () => {
    // This fixture has BOTH nextRouteForContract AND baseApi({ requiredScopes }).
    // The gate's exemption branch (grep -rLE "nextRouteForContract") must exclude it.
    // Removing that branch from the script must break this test.
    it('does NOT flag a handler that uses nextRouteForContract even if it also imports baseApi', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'dual.ts', EXEMPT_DUAL);
      const r = runGuard(dir, ['--error']);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain(rel);
    });
  });

  describe('violation detection', () => {
    it('detects a plain baseApi({ requiredScopes }) violator and includes its path in output', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(0); // warning mode exits 0
      expect(r.stdout).toContain(rel);
    });

    it('detects a generic baseApi<T>({ requiredScopes }) violator', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'generic-bad.ts', VIOLATING_GENERIC);
      const r = runGuard(dir);
      expect(r.status).toBe(0); // warning mode exits 0
      expect(r.stdout).toContain(rel);
    });

    it('does not flag a handler that has no requiredScopes', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'no-scopes.ts', CLEAN_NO_SCOPES);
      const r = runGuard(dir, ['--error']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('does not flag files under __tests__/', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, '__tests__/bad.test.ts', VIOLATING);
      const r = runGuard(dir, ['--error']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('does not flag files in a premium-* subdirectory', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'premium-overlay/bad.ts', VIOLATING);
      const r = runGuard(dir, ['--error']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });
  });

  describe('--error mode', () => {
    it('exits 0 in --error mode when there are no new violators', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'clean.ts', EXEMPT_CONTRACT);
      expect(runGuard(dir, ['--error']).status).toBe(0);
    });

    it('exits 1 in --error mode when a new (non-allowlisted) violator exists', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'bad.ts', VIOLATING);
      expect(runGuard(dir, ['--error']).status).toBe(1);
    });
  });

  describe('allowlist', () => {
    it('does not flag an allowlisted path (exits 0 even under --error)', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const rel = writeHandler(v1Dir, 'legacy.ts', VIOLATING);
      fs.writeFileSync(allowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir, ['--error']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('reports stale allowlist entries that are no longer violating', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const rel = writeHandler(v1Dir, 'migrated.ts', EXEMPT_CONTRACT);
      fs.writeFileSync(allowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain(rel);
    });

    it('emits a GitHub Actions ::warning:: annotation for new violators', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.stdout).toContain('::warning::');
    });
  });
});
