// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../../scripts/check-no-overlay-literals.sh', import.meta.url)),
  'utf8'
);

// Assembled at runtime so this file does not itself contain a guarded literal.
const WORD = ['quan', 'tum'].join('');
// Bracketed so an allowlist entry does not itself match the guarded pattern.
const WORD_RE = ['quan[t]', 'um'].join('');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Runs the guard in a scratch git repo so it never inspects the real checkout.
const runGuard = (files: Record<string, string>, allowlist: string[], args: string[] = []) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-literals-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/check-no-overlay-literals.sh'), SCRIPT_SOURCE);
  fs.writeFileSync(path.join(root, 'scripts/overlay-literals-allowlist.txt'), allowlist.join('\n') + '\n');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  const res = spawnSync('bash', ['scripts/check-no-overlay-literals.sh', ...args], { cwd: root, encoding: 'utf8' });
  return { status: res.status, out: res.stdout + res.stderr };
};

describe('check-no-overlay-literals.sh', () => {
  it('passes on a tree with no matches and an empty allowlist', () => {
    const { status, out } = runGuard({ 'a.txt': 'nothing here\n' }, ['# empty']);
    expect(status).toBe(0);
    expect(out).toContain('No unallowlisted overlay literals');
  });

  it('fails on an unallowlisted content match', () => {
    const { status, out } = runGuard({ 'src/a.ts': `const x = '${WORD}';\n` }, []);
    expect(status).toBe(1);
    expect(out).toContain('src/a.ts');
    expect(out).toContain('not allowlisted');
  });

  it('fails on a term embedded in a camelCase identifier', () => {
    const embedded = `is${WORD[0].toUpperCase()}${WORD.slice(1)}Enabled`;
    const { status, out } = runGuard({ 'src/a.ts': `const ${embedded} = true;\n` }, []);
    expect(status).toBe(1);
    expect(out).toContain('src/a.ts');
  });

  it('catches the short term when embedded but not inside an unrelated word', () => {
    const short = ['I', 'on', 'Q'].join('');
    expect(runGuard({ 'src/a.ts': `const is${short}Enabled = 1;\n` }, []).status).toBe(1);
    const unrelated = ['func', 'tion', 'Queue'].join('');
    expect(runGuard({ 'src/b.ts': `const ${unrelated} = 1;\n` }, ['# empty']).status).toBe(0);
  });

  it('fails on an unallowlisted path match', () => {
    const { status, out } = runGuard({ [`docs/${WORD}-notes.md`]: 'plain\n' }, []);
    expect(status).toBe(1);
    expect(out).toContain(`docs/${WORD}-notes.md`);
  });

  it('passes when the match is allowlisted by exact path', () => {
    const { status } = runGuard({ 'src/a.ts': `const x = '${WORD}';\n` }, ['src/a.ts']);
    expect(status).toBe(0);
  });

  it('fails on a stale allowlist entry', () => {
    const { status, out } = runGuard({ 'src/clean.ts': 'ok\n' }, ['src/clean.ts']);
    expect(status).toBe(1);
    expect(out).toContain('no longer match anything');
    expect(out).toContain('src/clean.ts');
  });

  it('matches re: entries against the whole path, including alternations', () => {
    const files = { [`a/${WORD}.md`]: 'x\n', [`b/${WORD}.md`]: 'x\n' };
    expect(runGuard(files, [`re:a/${WORD_RE}\\.md|b/${WORD_RE}\\.md`]).status).toBe(0);
    // An alternation must be anchored as a whole, not per branch.
    const partial = runGuard({ [`a/${WORD}.md.bak`]: 'x\n' }, [`re:a/${WORD_RE}\\.md|b/${WORD_RE}\\.md`]);
    expect(partial.status).toBe(1);
  });

  it('--list prints matching paths without consulting the allowlist', () => {
    const { status, out } = runGuard({ 'src/a.ts': `const x = '${WORD}';\n`, 'b.txt': 'ok\n' }, [], ['--list']);
    expect(status).toBe(0);
    expect(out.trim()).toBe('src/a.ts');
  });
});
