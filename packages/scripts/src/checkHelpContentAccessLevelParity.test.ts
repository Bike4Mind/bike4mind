import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for the accessLevel assertions in .husky/check-help-content.sh.
 *
 * accessLevel is the only gate keeping admin-only help docs out of a non-admin user's Help AI
 * chat answers - apps/client/server/help/retrieval.ts filters on it in both retrieval paths
 * (embeddings chunks in the vector search, index entries in the keyword fallback). Every other
 * guard on these artifacts compares slug SETS, so an artifact with chunks relabeled 'public' was
 * byte-indistinguishable from a correct one as far as CI was concerned.
 *
 * Each case builds a throwaway repo under the OS temp dir holding only the two generated
 * artifacts and runs the real script against it, so the assertions cover the shipped shell rather
 * than a reimplementation. Same shape as checkNoSmartPunctuation.test.ts. Assertions match ASCII
 * substrings of the script's output, because CLAUDE.md keeps this file ASCII-only while the
 * script's own report uses glyphs.
 *
 * The pre-existing "every indexed article has a vector" and fail-closed-on-malformed assertions
 * are pinned here too - the accessLevel checks were added alongside them and must not displace
 * them.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, '.husky', 'check-help-content.sh');
const GENERATED_DIR = path.join('apps', 'client', 'app', 'generated');

/** One record of either artifact: an index entry or an embeddings chunk. */
type HelpRecord = { slug: string; accessLevel?: string; sectionPath?: string };

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A repo holding just the two artifacts the script reads. It resolves them from relative paths,
 * so cwd is what selects the fixtures over the real ones. A git repo rather than a bare
 * directory because the script opens with `git diff --cached` for its staleness warning.
 */
function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-level-guard-'));
  sandboxes.push(dir);
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, GENERATED_DIR), { recursive: true });
  return dir;
}

function writeArtifacts(dir: string, entries: Array<Partial<HelpRecord>>, chunks: Array<Partial<HelpRecord>>) {
  writeRaw(dir, 'help-index.json', JSON.stringify({ entries }));
  writeRaw(dir, 'help-embeddings.json', JSON.stringify({ chunks }));
}

function writeRaw(dir: string, name: string, contents: string) {
  fs.writeFileSync(path.join(dir, GENERATED_DIR, name), contents, 'utf8');
}

/** `sh`, matching both entry points: .husky/pre-commit and the three ci.yml invocations. */
function runGuard(cwd: string) {
  const r = spawnSync('sh', [GUARD], { cwd, encoding: 'utf8' });
  if (r.error) throw r.error; // a spawn failure is not a guard verdict; surface it as such
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const chunk = (slug: string, accessLevel: string, sectionPath = 'Section'): HelpRecord => ({
  slug,
  accessLevel,
  sectionPath,
});
const entry = (slug: string, accessLevel: string): HelpRecord => ({ slug, accessLevel });

describe('check-help-content.sh accessLevel parity', () => {
  it('passes on artifacts that agree', () => {
    const dir = makeSandbox();
    writeArtifacts(
      dir,
      [entry('features/foo', 'public'), entry('admin/bar', 'admin')],
      [chunk('features/foo', 'public'), chunk('admin/bar', 'admin')]
    );
    expect(runGuard(dir).status).toBe(0);
  });

  it('passes against the real committed artifacts', () => {
    // The false positive that would matter most: an assertion that blocks every commit in the
    // repo. Runs the shipped script over the shipped artifacts, which is what CI does.
    expect(runGuard(REPO_ROOT).status).toBe(0);
  });

  it("fails when a chunk's accessLevel disagrees with its index entry", () => {
    const dir = makeSandbox();
    writeArtifacts(dir, [entry('features/foo', 'public')], [chunk('features/foo', 'admin')]);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    // Both sides named, so the reader can tell which artifact drifted.
    expect(r.stdout).toContain('features/foo: embeddings say admin, index says public');
  });

  it('fails when a chunk has no index entry at all', () => {
    // The direction the pre-existing check does not cover: it asserts index -> embeddings, and at
    // runtime an unindexed chunk is still scored and served on its own accessLevel.
    const dir = makeSandbox();
    writeArtifacts(
      dir,
      [entry('features/foo', 'public')],
      [chunk('features/foo', 'public'), chunk('features/ghost', 'public')]
    );
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('features/ghost: has no help-index.json entry');
  });

  it('distinguishes an index entry with no accessLevel from a missing entry', () => {
    // Theoretical today - loadHelpArticles.ts defaults accessLevel at generation time - but a
    // lone `want === undefined` check would file this under "no index entry", sending the reader
    // after the wrong artifact. The slug IS indexed; what is missing is the field.
    const dir = makeSandbox();
    writeArtifacts(dir, [{ slug: 'features/foo' }], [chunk('features/foo', 'public')]);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('features/foo: has a help-index.json entry with no accessLevel');
  });

  it('fails an admin article labeled public even when both artifacts agree', () => {
    // Parity alone sees nothing here - the artifacts agree, on the wrong level. This is the
    // shape a full regenerate against a tampered index would produce.
    const dir = makeSandbox();
    writeArtifacts(dir, [entry('admin/bar', 'public')], [chunk('admin/bar', 'public')]);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('admin/bar in help-index.json: accessLevel is public, expected admin');
    expect(r.stdout).toContain('admin/bar in help-embeddings.json: accessLevel is public, expected admin');
  });

  it('fails a bare "admin" slug labeled public, which an admin/ prefix test would miss', () => {
    // vectorize-help-content.ts collapses a directory index to the directory itself, so a
    // docs-site/docs/admin/index.md yields the slug 'admin' - no trailing slash to match. Pins
    // the top-path-segment comparison against a refactor back to startsWith('admin/').
    const dir = makeSandbox();
    writeArtifacts(dir, [entry('admin', 'public')], [chunk('admin', 'public')]);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('admin in help-index.json: accessLevel is public, expected admin');
  });

  it('allows a features article labeled admin, the over-restrictive direction', () => {
    // Deliberately out of scope: the category rule covers only the direction that leaks. Fully
    // validating the index's own levels against CATEGORY_ACCESS_LEVELS would mean duplicating
    // that table into shell-embedded JS, and belongs with a rebuild-and-compare harness.
    const dir = makeSandbox();
    writeArtifacts(dir, [entry('features/foo', 'admin')], [chunk('features/foo', 'admin')]);
    expect(runGuard(dir).status).toBe(0);
  });

  it('reports a mislabeled article once with a chunk count, not once per chunk', () => {
    // A real article has dozens of chunks and one remedy. Per-chunk bullets would bury a
    // whole-artifact relabel under hundreds of near-identical lines.
    const dir = makeSandbox();
    writeArtifacts(
      dir,
      [entry('features/foo', 'public')],
      [
        chunk('features/foo', 'admin', 'One'),
        chunk('features/foo', 'admin', 'Two'),
        chunk('features/foo', 'admin', 'Three'),
      ]
    );
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('features/foo: embeddings say admin, index says public (3 chunks)');
  });

  it('names every offending slug, not just the first', () => {
    const dir = makeSandbox();
    writeArtifacts(
      dir,
      [entry('features/a', 'public'), entry('features/b', 'public')],
      [chunk('features/a', 'admin'), chunk('features/b', 'admin')]
    );
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('features/a:');
    expect(r.stdout).toContain('features/b:');
  });

  describe('pre-existing assertions still hold', () => {
    it('still fails when an indexed article has no embeddings', () => {
      const dir = makeSandbox();
      writeArtifacts(
        dir,
        [entry('features/foo', 'public'), entry('features/novec', 'public')],
        [chunk('features/foo', 'public')]
      );
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Help index has articles with no embeddings');
    });

    it.each(['help-index.json', 'help-embeddings.json'])('still fails closed on a malformed %s', name => {
      const dir = makeSandbox();
      writeArtifacts(dir, [entry('features/foo', 'public')], [chunk('features/foo', 'public')]);
      writeRaw(dir, name, 'not json');
      expect(runGuard(dir).status).toBe(1);
    });

    it.each(['help-index.json', 'help-embeddings.json'])('still fails when %s is missing entirely', name => {
      const dir = makeSandbox();
      writeArtifacts(dir, [entry('features/foo', 'public')], [chunk('features/foo', 'public')]);
      fs.rmSync(path.join(dir, GENERATED_DIR, name));
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('A generated help artifact is missing');
    });
  });

  // A record with no slug at all reaches `r.slug.split(...)`. That must throw into the script's
  // fail-closed wrapper rather than skip the record: an unslugged chunk is unattributable, so
  // "cannot check" is the only honest verdict. The fixture pairs it with a well-formed chunk
  // covering the sole index entry, so the earlier slug-set check passes and this block is the
  // one that decides.
  it('fails closed on a record with no slug rather than skipping it', () => {
    const dir = makeSandbox();
    writeArtifacts(
      dir,
      [entry('features/foo', 'public')],
      [chunk('features/foo', 'public'), { accessLevel: 'public', sectionPath: 'Orphan' }]
    );
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Could not compare help accessLevel across the two artifacts');
  });
});
