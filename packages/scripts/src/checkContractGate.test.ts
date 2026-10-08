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

function makeTree(): { dir: string; v1Dir: string; allowlist: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));
  sandboxes.push(dir);
  const v1Dir = path.join(dir, 'apps', 'client', 'pages', 'api', 'v1');
  fs.mkdirSync(v1Dir, { recursive: true });
  const allowlist = path.join(dir, 'scripts', 'contract-gate-allowlist.txt');
  fs.mkdirSync(path.dirname(allowlist), { recursive: true });
  fs.writeFileSync(allowlist, '# header-only\n', 'utf8');
  return { dir, v1Dir, allowlist };
}

function writeHandler(v1Dir: string, rel: string, content: string): string {
  const full = path.join(v1Dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return path.join('apps', 'client', 'pages', 'api', 'v1', rel);
}

// Any v1 file without nextRouteForContract is a violator -- predicate is presence-only.
const VIOLATING = `
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] }).get((req, res) => res.json({}));
export default h;
`.trimStart();

// A file with nextRouteForContract is exempt, regardless of anything else it imports.
const EXEMPT = `
import { nextRouteForContract } from '@server/middlewares/nextRouteForContract';
export default nextRouteForContract(contract, async (req) => ({ data: null }));
`.trimStart();

/**
 * Critical regression fixture: has BOTH nextRouteForContract AND baseApi({ requiredScopes }).
 * Removing the exemption branch (grep -rLZ "nextRouteForContract") must break this test.
 */
const EXEMPT_DUAL = `
import { nextRouteForContract } from '@server/middlewares/nextRouteForContract';
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] });
export default nextRouteForContract(contract, async (req) => ({ data: null }));
`.trimStart();

// A file with a TODO comment about nextRouteForContract but NO actual import -- still a violator.
const VIOLATING_TODO_COMMENT = `
// TODO: port to nextRouteForContract
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] }).get((req, res) => res.json({}));
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

  it('is wired in .github/workflows/ci.yml', () => {
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/bash\s+scripts\/check-contract-gate\.sh/);
  });

  it('exits 0 and reports OK when there are no violations', () => {
    const { dir, v1Dir } = makeTree();
    writeHandler(v1Dir, 'clean.ts', EXEMPT);
    const r = runGuard(dir);
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
    expect(runGuard(dir).status).toBe(0);
  });

  describe('contract-adapter exemption (critical regression)', () => {
    // Removing the grep -rLZ "nextRouteForContract" branch from the script must break this.
    it('does NOT flag a file that contains nextRouteForContract, even if it also imports baseApi', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'dual.ts', EXEMPT_DUAL);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain(rel);
    });
  });

  describe('violation detection', () => {
    it('flags a v1 file that lacks nextRouteForContract and reports its path', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('flags a file whose only mention of nextRouteForContract is a TODO comment', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'todo-bypass.ts', VIOLATING_TODO_COMMENT);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('does not flag files under __tests__/', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, '__tests__/bad.test.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('does not flag files in a premium-* subdirectory', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'premium-overlay/bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });
  });

  describe('allowlist', () => {
    it('does not flag an allowlisted path', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const rel = writeHandler(v1Dir, 'static-exception.ts', VIOLATING);
      fs.writeFileSync(allowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('reports stale allowlist entries that no longer need exemption (exits 0)', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const rel = writeHandler(v1Dir, 'now-clean.ts', EXEMPT);
      fs.writeFileSync(allowlist, `# header\n${rel}\n`, 'utf8');
      // Stale entries alone must not trigger exit 1.
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain(rel);
    });

    it('emits a GitHub Actions ::error:: annotation for new violators', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.stdout).toContain('::error::');
    });
  });
});
