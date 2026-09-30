import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_DEPTH,
  MAX_INSTRUCTIONS_BYTES,
  defaultUserInstructionsRoot,
  loadInstructions,
} from './instructions';

async function scratch(prefix = 'b4m-instr-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe('defaultUserInstructionsRoot', () => {
  it('is ~/.claude, the same folder the skills loader reads', () => {
    expect(defaultUserInstructionsRoot()).toBe(join(homedir(), '.claude'));
  });
});

describe('layering', () => {
  let project: string;
  let userRoot: string;

  beforeEach(async () => {
    project = await scratch();
    userRoot = await scratch('b4m-instr-user-');
  });

  it('gives a session with no project the user instructions alone', async () => {
    await writeFile(join(userRoot, 'CLAUDE.md'), 'always answer in haiku', 'utf8');
    const blocks = await loadInstructions(undefined, undefined, userRoot);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].scope).toBe('user');
    expect(blocks[0].text).toContain('always answer in haiku');
  });

  it('returns the user block before the project block so the project one wins', async () => {
    await writeFile(join(userRoot, 'CLAUDE.md'), 'user rules', 'utf8');
    await writeFile(join(project, 'CLAUDE.md'), 'project rules', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    expect(blocks.map(block => block.scope)).toEqual(['user', 'project']);
    expect(blocks[0].text).toContain('user rules');
    expect(blocks[1].text).toContain('project rules');
  });

  it('still falls back to AGENTS.md for the project block', async () => {
    await writeFile(join(project, 'AGENTS.md'), 'agents rules', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].file).toBe('AGENTS.md');
    expect(blocks[0].text).toContain('agents rules');
  });

  it('prefers CLAUDE.md in the project directory over AGENTS.md in the worktree', async () => {
    const worktree = await scratch();
    await writeFile(join(worktree, 'AGENTS.md'), 'agents rules', 'utf8');
    await writeFile(join(project, 'CLAUDE.md'), 'claude rules', 'utf8');
    const blocks = await loadInstructions(worktree, project, userRoot);
    expect(blocks[0].text).toContain('claude rules');
    expect(blocks[0].text).not.toContain('agents rules');
  });

  it('returns nothing when neither level has a file', async () => {
    expect(await loadInstructions(project, project, userRoot)).toEqual([]);
  });
});

describe('imports', () => {
  let project: string;
  let userRoot: string;

  beforeEach(async () => {
    project = await scratch();
    userRoot = await scratch('b4m-instr-user-');
  });

  async function projectText(body: string): Promise<string> {
    await writeFile(join(project, 'CLAUDE.md'), body, 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    return blocks.map(block => block.text).join('\n');
  }

  it('resolves a relative import against the importing file', async () => {
    await mkdir(join(project, 'docs'));
    await writeFile(join(project, 'docs', 'style.md'), 'two spaces, never tabs', 'utf8');
    const text = await projectText('See @docs/style.md for the house style.');
    expect(text).toContain('two spaces, never tabs');
    expect(text).toContain(`begin import ${join(project, 'docs', 'style.md')}`);
    // The line that named the import is kept, so the model reads why it is there.
    expect(text).toContain('for the house style');
  });

  it('resolves an import relative to the file that wrote it, not the top-level one', async () => {
    await mkdir(join(project, 'docs'));
    await writeFile(join(project, 'docs', 'a.md'), 'see @b.md', 'utf8');
    await writeFile(join(project, 'docs', 'b.md'), 'deepest rule', 'utf8');
    expect(await projectText('@docs/a.md')).toContain('deepest rule');
  });

  it('expands ~ against the home directory', async () => {
    const text = await projectText('@~/.ssh/config.md');
    // Not a hit either way here - what matters is that it was resolved and then refused,
    // rather than being read as a file literally named "~".
    expect(text).toContain('[import @~/.ssh/config.md refused');
  });

  it(`stops at ${MAX_IMPORT_DEPTH} hops`, async () => {
    const chain = MAX_IMPORT_DEPTH + 3;
    for (let i = 0; i < chain; i++) {
      await writeFile(join(project, `n${i}.md`), `level ${i}\n@n${i + 1}.md`, 'utf8');
    }
    const text = await projectText('@n0.md');
    // Depth counts the hops taken from the top-level file, so the last file reached is the one
    // at MAX_IMPORT_DEPTH - 1, and its own import is the one refused.
    expect(text).toContain(`level ${MAX_IMPORT_DEPTH - 1}`);
    expect(text).not.toContain(`level ${MAX_IMPORT_DEPTH}`);
    expect(text).toContain(`imports go only ${MAX_IMPORT_DEPTH} deep`);
  });

  it('terminates on a self-import', async () => {
    await writeFile(join(project, 'loop.md'), 'loop body\n@loop.md', 'utf8');
    const text = await projectText('@loop.md');
    expect(text).toContain('loop body');
    expect(text).toContain('already included above');
  });

  it('terminates on a two-file cycle', async () => {
    await writeFile(join(project, 'a.md'), 'a body\n@b.md', 'utf8');
    await writeFile(join(project, 'b.md'), 'b body\n@a.md', 'utf8');
    const text = await projectText('@a.md');
    expect(text).toContain('a body');
    expect(text).toContain('b body');
    expect(text).toContain('already included above');
  });

  it('terminates when the top-level file imports itself', async () => {
    const text = await projectText('top body\n@CLAUDE.md');
    expect(text).toContain('top body');
    expect(text).toContain('already included above');
  });

  it('notes a missing import and still loads everything else', async () => {
    const text = await projectText('first rule\n@gone.md\nsecond rule');
    expect(text).toContain('first rule');
    expect(text).toContain('second rule');
    expect(text).toContain('[import @gone.md not found.]');
  });

  it('ignores an @path inside a fenced code block or a code span', async () => {
    await writeFile(join(project, 'secret.md'), 'should not appear', 'utf8');
    const text = await projectText(['Write it like `@secret.md`:', '```', '@secret.md', '```', 'done'].join('\n'));
    expect(text).not.toContain('should not appear');
    expect(text).not.toContain('begin import');
  });

  it('does not treat an email address as an import', async () => {
    const text = await projectText('Ask someone@example.com.md about it.');
    expect(text).not.toContain('[import');
  });
});

describe('import containment', () => {
  let project: string;
  let userRoot: string;

  beforeEach(async () => {
    project = await scratch();
    userRoot = await scratch('b4m-instr-user-');
  });

  async function refusalFor(body: string): Promise<string> {
    await writeFile(join(project, 'CLAUDE.md'), body, 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    return blocks[0].text;
  }

  it('refuses an import that climbs out with ..', async () => {
    const outside = await scratch('b4m-instr-outside-');
    await writeFile(join(outside, 'stolen.md'), 'SECRET PAYLOAD', 'utf8');
    const text = await refusalFor(`@../${outside.split('/').pop()}/stolen.md`);
    expect(text).not.toContain('SECRET PAYLOAD');
    expect(text).toContain('refused, outside this project');
  });

  it('refuses an absolute import outside every root', async () => {
    const outside = await scratch('b4m-instr-outside-');
    await writeFile(join(outside, 'stolen.md'), 'SECRET PAYLOAD', 'utf8');
    const text = await refusalFor(`@${join(outside, 'stolen.md')}`);
    expect(text).not.toContain('SECRET PAYLOAD');
    expect(text).toContain('refused, outside this project');
  });

  it('refuses a symlink inside the project that points outside it', async () => {
    const outside = await scratch('b4m-instr-outside-');
    await writeFile(join(outside, 'stolen.md'), 'SECRET PAYLOAD', 'utf8');
    await symlink(join(outside, 'stolen.md'), join(project, 'innocent.md'));
    const text = await refusalFor('@innocent.md');
    expect(text).not.toContain('SECRET PAYLOAD');
    expect(text).toContain('refused, outside this project');
  });

  it('refuses a credential path the write tools already protect', async () => {
    for (const spec of ['~/.ssh/id_rsa.md', '~/.aws/credentials.md', '~/.gnupg/secring.md']) {
      expect(await refusalFor(`@${spec}`)).toContain('refused');
    }
  });

  it('refuses a credential store reached through a symlink inside the project', async () => {
    await symlink(join(homedir(), '.ssh'), join(project, 'keys'));
    expect(await refusalFor('@keys/id_rsa.md')).toContain('refused');
  });

  it('refuses a non-markdown import, which is what keeps ~/.claude/.credentials.json out', async () => {
    await writeFile(join(userRoot, '.credentials.json'), '{"token":"SECRET PAYLOAD"}', 'utf8');
    const text = await refusalFor(`@${join(userRoot, '.credentials.json')}`);
    expect(text).not.toContain('SECRET PAYLOAD');
    expect(text).toContain('refused, only .md files can be imported');
  });

  it('allows an import inside the user instructions folder', async () => {
    await writeFile(join(userRoot, 'style.md'), 'the shared house style', 'utf8');
    expect(await refusalFor(`@${join(userRoot, 'style.md')}`)).toContain('the shared house style');
  });

  it('allows a project import reached from the user file', async () => {
    await writeFile(join(project, 'shared.md'), 'project detail', 'utf8');
    await writeFile(join(userRoot, 'CLAUDE.md'), `@${join(project, 'shared.md')}`, 'utf8');
    await writeFile(join(project, 'CLAUDE.md'), 'project rules', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    expect(blocks[0].text).toContain('project detail');
  });
});

describe('the shared budget', () => {
  let project: string;
  let userRoot: string;

  beforeEach(async () => {
    project = await scratch();
    userRoot = await scratch('b4m-instr-user-');
  });

  const filler = (label: string, lines: number): string =>
    Array.from({ length: lines }, (_, i) => `${label} line ${i + 1} ${'x'.repeat(20)}`).join('\n');

  it('truncates on a line boundary and names the line to continue from', async () => {
    const path = join(project, 'CLAUDE.md');
    await writeFile(path, filler('p', 4_000), 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    const text = blocks[0].text;

    const shown = /first (\d+) lines/.exec(text);
    expect(shown).not.toBeNull();
    const count = Number(shown?.[1]);
    expect(text).toContain(`file_read on ${path} with offset ${count + 1}`);
    expect(text).toContain(`p line ${count} `);
    expect(text).not.toContain(`p line ${count + 1} `);
  });

  it('is a total across both levels, spent on the project file first', async () => {
    await writeFile(join(project, 'CLAUDE.md'), filler('p', 4_000), 'utf8');
    await writeFile(join(userRoot, 'CLAUDE.md'), filler('u', 4_000), 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    const total = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);

    // The project file is the more specific, so it is the one that keeps its bytes.
    const project_ = blocks.find(block => block.scope === 'project');
    expect(project_?.text).toContain('p line 1 ');
    // Each block's own truncation notice sits outside the budget; a small allowance for them.
    expect(total).toBeLessThan(MAX_INSTRUCTIONS_BYTES + 2_000);
  });

  it('drops the general level entirely rather than the specific one when the budget is gone', async () => {
    await writeFile(join(project, 'CLAUDE.md'), filler('p', 8_000), 'utf8');
    await writeFile(join(userRoot, 'CLAUDE.md'), 'user rules that will not fit', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    expect(blocks.map(block => block.scope)).toEqual(['project']);
  });

  it('leaves out an import that no longer fits and says so', async () => {
    await writeFile(join(project, 'big.md'), filler('b', 8_000), 'utf8');
    await writeFile(join(project, 'later.md'), 'never reached', 'utf8');
    await writeFile(join(project, 'CLAUDE.md'), 'start\n@big.md\n@later.md', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot);
    expect(blocks[0].text).toContain('the instruction budget is full');
    expect(blocks[0].text).not.toContain('never reached');
  });
});
