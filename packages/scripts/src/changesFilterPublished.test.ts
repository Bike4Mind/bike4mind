import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Executes the changes-filter step's shell against a throwaway git repo and asserts the
 * `published-changed` output, including both fail-open arms: an unresolvable range and a failing diff.
 * The gate is the only thing that runs `published-dts`, and a wrong `false` skips it quietly.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const action = fs.readFileSync(path.join(REPO_ROOT, '.github', 'actions', 'changes-filter', 'action.yml'), 'utf8');

/** The body under `key:` dedented by the indent of its first line, ending at the first line that is less indented. */
function readBlock(lines: string[], start: number): string {
  const body: string[] = [];
  const keyIndent = lines[start].search(/\S/);
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter(l => l.trim()).map(l => l.search(/\S/)));
  return body.map(l => l.slice(indent)).join('\n');
}

/** The `run: |` script of the step with `id: filter`. */
function filterScript(): string {
  const lines = action.split('\n');
  const idAt = lines.findIndex(l => /^\s*- id: filter\s*$/.test(l));
  const runAt = lines.findIndex((l, i) => i > idAt && /^\s*run: \|\s*$/.test(l));
  expect(idAt).toBeGreaterThan(-1);
  expect(runAt).toBeGreaterThan(idAt);
  return readBlock(lines, runAt);
}

/** An input's literal `default: |` text, as the runner would hand it to the step. */
function inputDefault(name: string): string {
  const lines = action.split('\n');
  const inputAt = lines.findIndex(l => l === `  ${name}:`);
  const defaultAt = lines.findIndex((l, i) => i > inputAt && /^ {4}default: \|\s*$/.test(l));
  expect(inputAt).toBeGreaterThan(-1);
  expect(defaultAt).toBeGreaterThan(inputAt);
  return `${readBlock(lines, defaultAt)}\n`;
}

const script = filterScript();
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

/** A repo whose second commit adds `changedFile`; returns both shas. */
function makeRepo(changedFile: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'changes-filter-'));
  tmpDirs.push(cwd);
  const git = (...args: string[]) => {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    expect(res.status, res.stderr).toBe(0);
    return res.stdout.trim();
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'seed');
  const before = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.dirname(path.join(cwd, changedFile)), { recursive: true });
  fs.writeFileSync(path.join(cwd, changedFile), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'change');
  return { cwd, before, after: git('rev-parse', 'HEAD') };
}

function publishedChanged(cwd: string, before: string, after: string): string | undefined {
  const out = path.join(cwd, '..', `${path.basename(cwd)}.output`);
  fs.writeFileSync(out, '');
  tmpDirs.push(out);
  const res = spawnSync('bash', ['-c', script], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_OUTPUT: out,
      EVENT_NAME: 'push',
      PUSH_BEFORE: before,
      PUSH_AFTER: after,
      EXCLUDE_PATHS: inputDefault('exclude-paths'),
      DOCS_PATHS: inputDefault('docs-paths'),
      PUBLISHED_PATHS: inputDefault('published-paths'),
    },
    encoding: 'utf8',
  });
  expect(res.status, res.stderr + res.stdout).toBe(0);
  const lines = fs.readFileSync(out, 'utf8').split('\n');
  return lines.find(l => l.startsWith('published-changed='))?.slice('published-changed='.length);
}

describe('changes-filter published-changed', () => {
  let docsOnly: ReturnType<typeof makeRepo>;
  beforeAll(() => {
    docsOnly = makeRepo('docs-site/intro.md');
  });

  it('is true when a commit touches b4m-core', () => {
    const { cwd, before, after } = makeRepo('b4m-core/utils/src/index.ts');
    expect(publishedChanged(cwd, before, after)).toBe('true');
  });

  it('is false when a commit touches only docs-site', () => {
    const { cwd, before, after } = docsOnly;
    expect(publishedChanged(cwd, before, after)).toBe('false');
  });

  it('fails open to true on an all-zero base', () => {
    const { cwd, after } = docsOnly;
    expect(publishedChanged(cwd, '0'.repeat(40), after)).toBe('true');
  });

  it('fails open to true when the diff itself fails', () => {
    // A base that exists as an object but is not a commit passes cat-file and then fails git diff.
    const { cwd, after } = docsOnly;
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd,
      input: 'blob',
      encoding: 'utf8',
    }).stdout.trim();
    expect(publishedChanged(cwd, blob, after)).toBe('true');
  });
});
