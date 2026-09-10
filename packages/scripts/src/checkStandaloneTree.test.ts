import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Exercises apps/client/scripts/check-standalone-tree.mjs, the last thing the container build
 * runs before the standalone output is copied into the runner image.
 *
 * The guard exists because a @vercel/nft directory-glob fallback swept all of apps/client into
 * the build output, and nothing failed: the image built, the Lambda deployed, and the only
 * symptom was tens of MB of raw source riding along inside a bundle already near Lambda's
 * 250 MB unzipped cap. A byte budget would not have caught it either - most of the standalone
 * tree is .nft.json metadata whose size barely moves. What DOES move is the entry list, so
 * that is what gets pinned.
 *
 * Run as a subprocess rather than imported: the script's contract is its exit code and the
 * offenders it names on stderr, which is exactly what the Dockerfile depends on.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'apps', 'client', 'scripts', 'check-standalone-tree.mjs');

const HEALTHY_ENTRIES = ['.next', 'app', 'node_modules', 'package.json', 'server.js'];

let tmpRoot: string;
let appDir: string;

/** Build a standalone app directory holding exactly the entries a healthy build emits. */
function makeHealthyTree(): void {
  for (const entry of HEALTHY_ENTRIES) {
    const full = path.join(appDir, entry);
    if (entry.includes('.json') || entry.endsWith('.js')) fs.writeFileSync(full, '{}');
    else fs.mkdirSync(full);
  }
  // The only thing under app/ that a healthy build emits: the help artifacts retrieval.ts
  // resolves against cwd on each request.
  fs.mkdirSync(path.join(appDir, 'app', 'generated'));
  fs.writeFileSync(path.join(appDir, 'app', 'generated', 'help-index.json'), '{}');
}

/** Run the guard, returning its exit status and combined output. */
function runGuard(target: string): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [GUARD, target], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-tree-'));
  appDir = path.join(tmpRoot, '.next', 'standalone', 'apps', 'client');
  fs.mkdirSync(appDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('check-standalone-tree', () => {
  it('passes on a healthy standalone tree', () => {
    makeHealthyTree();
    const { status, output } = runGuard(appDir);
    expect(status, output).toBe(0);
    expect(output).toContain('is clean');
  });

  it('fails and names the offenders when file tracing sweeps the app source tree in', () => {
    makeHealthyTree();
    // The shape the regression produced: source directories from apps/client landing beside
    // the five real entries.
    for (const swept of ['server', 'pages', 'e2e', 'next.config.mjs']) {
      const full = path.join(appDir, swept);
      if (swept.endsWith('.mjs')) fs.writeFileSync(full, '');
      else fs.mkdirSync(full);
    }

    const { status, output } = runGuard(appDir);
    expect(status).toBe(1);
    expect(output).toContain('4 unexpected entries');
    for (const swept of ['server', 'pages', 'e2e', 'next.config.mjs']) {
      expect(output).toContain(swept);
    }
    expect(output).toContain('file tracing swept the app source tree');
  });

  it('rejects a sweep that lands inside app/, which a top-level allowlist would miss', () => {
    makeHealthyTree();
    // app/ is the SPA source root, so this is where a sweep is likeliest to land and the one
    // place a top-level-only allowlist reports clean while shipping the source tree.
    fs.mkdirSync(path.join(appDir, 'app', 'components'));
    fs.writeFileSync(path.join(appDir, 'app', 'router.tsx'), '');

    const { status, output } = runGuard(appDir);
    expect(status).toBe(1);
    expect(output).toContain('2 unexpected entries');
    expect(output).toContain('app/components');
    expect(output).toContain('app/router.tsx');
  });

  it('is an allowlist, so it rejects an entry nobody thought to name', () => {
    makeHealthyTree();
    fs.mkdirSync(path.join(appDir, 'some-future-directory'));

    const { status, output } = runGuard(appDir);
    expect(status).toBe(1);
    expect(output).toContain('some-future-directory');
  });

  it('fails loudly rather than passing when the standalone output is missing', () => {
    const { status, output } = runGuard(path.join(tmpRoot, 'nope'));
    expect(status).toBe(1);
    expect(output).toContain('no standalone app directory');
  });

  it('fails and names what is missing when a truncated build drops an expected entry', () => {
    makeHealthyTree();
    fs.rmSync(path.join(appDir, 'server.js'));

    const { status, output } = runGuard(appDir);
    expect(status).toBe(1);
    expect(output).toContain('missing');
    expect(output).toContain('server.js');
  });
});
