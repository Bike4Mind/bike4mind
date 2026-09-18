import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Exercises apps/client/scripts/pruneTestRoutes.mjs's --if-standalone flag: the only hook that
 * fires on both the hosted (postbuild) and container (Dockerfile) paths cannot know in advance
 * whether `next build` wrote .next/standalone, so a missing standalone ROOT has to be a no-op
 * while a wrong path below that root stays fatal - otherwise a typo in the app segment would
 * silently skip pruning instead of failing the build.
 *
 * Run as a subprocess: the script's contract is its exit code and what it prints, which is what
 * postbuild and the Dockerfile both depend on.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'apps', 'client', 'scripts', 'pruneTestRoutes.mjs');

let tmpRoot: string;

function runScript(args: string[]): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

/** Writes a minimal pages-manifest.json with one real route and one compiled test route. */
function makeNextDir(nextDir: string): void {
  fs.mkdirSync(path.join(nextDir, 'server', 'pages', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'server', 'pages', 'index.js'), '');
  fs.writeFileSync(path.join(nextDir, 'server', 'pages', '__tests__', 'foo.test.js'), '');
  fs.writeFileSync(
    path.join(nextDir, 'server', 'pages-manifest.json'),
    JSON.stringify({
      '/': 'pages/index.js',
      '/__tests__/foo.test': 'pages/__tests__/foo.test.js',
    })
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-routes-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pruneTestRoutes', () => {
  it('prunes compiled test routes from pages-manifest.json and removes the __tests__ dir', () => {
    const nextDir = path.join(tmpRoot, '.next');
    makeNextDir(nextDir);

    const { status, output } = runScript([nextDir]);

    expect(status, output).toBe(0);
    expect(output).toContain('pruned 1 test routes, removed 1 __tests__ dirs');
    const manifest = JSON.parse(fs.readFileSync(path.join(nextDir, 'server', 'pages-manifest.json'), 'utf8'));
    expect(manifest).toEqual({ '/': 'pages/index.js' });
    expect(fs.existsSync(path.join(nextDir, 'server', 'pages', '__tests__'))).toBe(false);
  });

  it('fails with usage when no directory argument is given', () => {
    const { status, output } = runScript([]);
    expect(status).toBe(1);
    expect(output).toContain('usage: pruneTestRoutes.mjs');
  });

  it('fails when the target is missing pages-manifest.json, with no flag', () => {
    const { status, output } = runScript([tmpRoot]);
    expect(status).toBe(1);
    expect(output).toContain('usage: pruneTestRoutes.mjs');
  });

  it('--if-standalone is a clean no-op when the standalone root does not exist', () => {
    const target = path.join(tmpRoot, '.next', 'standalone', 'apps', 'client', '.next');
    const { status, output } = runScript(['--if-standalone', target]);
    expect(status, output).toBe(0);
    expect(output).toContain('nothing to prune');
  });

  it('--if-standalone still fails on a wrong path below an existing standalone root', () => {
    const standaloneRoot = path.join(tmpRoot, '.next', 'standalone');
    fs.mkdirSync(standaloneRoot, { recursive: true });
    const target = path.join(standaloneRoot, 'apps', 'typo-client', '.next');

    const { status, output } = runScript(['--if-standalone', target]);

    expect(status).toBe(1);
    expect(output).toContain('usage: pruneTestRoutes.mjs');
  });

  it('--if-standalone prunes normally once the standalone root and manifest both exist', () => {
    const standaloneRoot = path.join(tmpRoot, '.next', 'standalone');
    const nextDir = path.join(standaloneRoot, 'apps', 'client', '.next');
    makeNextDir(nextDir);

    const { status, output } = runScript(['--if-standalone', nextDir]);

    expect(status, output).toBe(0);
    expect(output).toContain('pruned 1 test routes, removed 1 __tests__ dirs');
  });

  it('rejects --if-standalone on a path with no standalone segment at all', () => {
    const { status, output } = runScript(['--if-standalone', tmpRoot]);
    expect(status).toBe(1);
    expect(output).toContain('needs a path under .next/standalone');
  });
});
