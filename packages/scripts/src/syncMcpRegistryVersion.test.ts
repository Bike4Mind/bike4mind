import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/sync-mcp-registry-version.mjs.
 *
 * Each case builds a throwaway two-file tree under the OS temp dir, copies the real
 * script into it, and runs it there -- so the assertions cover the shipped script
 * including the way it resolves its own repo root from import.meta.url. Nothing here
 * touches the working repo. Same shape as checkNoSmartPunctuation.test.ts.
 *
 * WHY THIS IS GUARDED: the script is chained into `changeset:version`, so it runs
 * unattended on the shared "Version Packages" PR that batches every pending
 * changeset in the monorepo. If it ever silently no-ops -- a renamed path, a
 * packages[0] that stops being the npm entry -- mcpRegistryEntry.test.ts goes red on
 * that PR and holds the merge queue for unrelated packages, which is the exact
 * failure the script was written to prevent. A silent no-op is the dangerous mode,
 * so "did it actually rewrite both fields" is asserted rather than the exit code.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-mcp-registry-version.mjs');

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

/**
 * Mirror the two paths the script reads, and copy the script to the same relative
 * position so its `../` root resolution lands on the sandbox.
 */
function sandbox(pkgVersion: string, server: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-mcp-'));
  sandboxes.push(root);
  fs.mkdirSync(path.join(root, 'packages', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mcp-registry'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'cli', 'package.json'),
    JSON.stringify({ name: '@bike4mind/cli', version: pkgVersion }, null, 2)
  );
  fs.writeFileSync(path.join(root, 'mcp-registry', 'server.json'), `${JSON.stringify(server, null, 2)}\n`);
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', path.basename(SCRIPT)));
  return root;
}

function run(root: string) {
  // cwd deliberately elsewhere: the script must resolve from import.meta.url, not cwd,
  // because changesets invokes it from the repo root but nothing guarantees that.
  return spawnSync(process.execPath, [path.join(root, 'scripts', path.basename(SCRIPT))], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
}

function readServer(root: string) {
  return JSON.parse(fs.readFileSync(path.join(root, 'mcp-registry', 'server.json'), 'utf8'));
}

const entry = (version: string) => ({
  name: 'io.github.bike4mind/bike4mind',
  version,
  packages: [{ registryType: 'npm', identifier: '@bike4mind/cli', version }],
});

describe('sync-mcp-registry-version', () => {
  it('moves both the top-level and nested version to the package version', () => {
    const root = sandbox('0.21.0', entry('0.20.2'));
    const result = run(root);

    expect(result.status).toBe(0);
    const server = readServer(root);
    expect(server.version).toBe('0.21.0');
    expect(server.packages[0].version).toBe('0.21.0');
    expect(result.stdout).toContain('0.20.2 -> 0.21.0');
  });

  it('is a no-op on a second run', () => {
    const root = sandbox('0.21.0', entry('0.20.2'));

    run(root);
    const afterFirst = fs.readFileSync(path.join(root, 'mcp-registry', 'server.json'), 'utf8');
    const second = run(root);
    const afterSecond = fs.readFileSync(path.join(root, 'mcp-registry', 'server.json'), 'utf8');

    expect(second.status).toBe(0);
    expect(afterSecond).toBe(afterFirst);
    expect(second.stdout).toContain('already at 0.21.0');
  });

  it('rewrites the nested version even when the top-level one already agrees', () => {
    // The half-synced state a hand-edit leaves behind. Both fields are checked
    // independently, so this must not be mistaken for "already in step".
    const root = sandbox('0.21.0', {
      ...entry('0.21.0'),
      packages: [{ registryType: 'npm', identifier: '@bike4mind/cli', version: '0.20.2' }],
    });

    expect(run(root).status).toBe(0);
    expect(readServer(root).packages[0].version).toBe('0.21.0');
  });

  it('preserves unrelated fields and trailing-newline formatting', () => {
    const root = sandbox('0.21.0', {
      ...entry('0.20.2'),
      description: 'do not touch me',
      packages: [
        {
          registryType: 'npm',
          identifier: '@bike4mind/cli',
          version: '0.20.2',
          environmentVariables: [{ name: 'B4M_API_URL', isRequired: true }],
        },
      ],
    });

    run(root);
    const raw = fs.readFileSync(path.join(root, 'mcp-registry', 'server.json'), 'utf8');
    const server = JSON.parse(raw);

    expect(server.description).toBe('do not touch me');
    expect(server.packages[0].environmentVariables).toEqual([{ name: 'B4M_API_URL', isRequired: true }]);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\n  "version"')).toBe(true);
  });
});
