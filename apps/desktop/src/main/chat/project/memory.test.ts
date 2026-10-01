import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_INSTRUCTIONS_BYTES, loadInstructions } from './instructions';
import {
  MEMORY_INDEX_FILE,
  type MemoryStore,
  applyMemoryPlan,
  assertMemoryName,
  frontmatterValue,
  planMemoryDelete,
  planMemoryWrite,
  projectSlug,
  resolveMemoryPath,
  resolveMemoryStore,
  updateIndex,
} from './memory';

const run = promisify(execFile);

async function scratch(prefix = 'b4m-memory-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** The store under a temp instructions root, so no test can reach the real ~/.claude. */
async function store(userRoot: string, slug = 'project'): Promise<MemoryStore> {
  const directory = join(userRoot, 'projects', slug, 'memory');
  await mkdir(directory, { recursive: true });
  return { directory, userInstructionsRoot: userRoot };
}

async function save(target: MemoryStore, name: string, content: string, title?: string): Promise<void> {
  await applyMemoryPlan(await planMemoryWrite(target, { name, content, ...(title ? { title } : {}) }));
}

describe('projectSlug', () => {
  it('is the absolute path with every separator turned into a hyphen', () => {
    expect(projectSlug('/Users/someone/code/app')).toBe('-Users-someone-code-app');
  });

  it('keeps one slug for one project however deep the path goes', () => {
    expect(projectSlug('/a/b')).not.toBe(projectSlug('/a/b/c'));
  });
});

describe('resolveMemoryStore', () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await scratch('b4m-memory-user-');
  });

  it('keys an ordinary checkout on the checkout itself', async () => {
    const repository = await scratch();
    await run('git', ['init', '-q'], { cwd: repository });

    const resolved = await resolveMemoryStore(repository, userRoot);
    expect(resolved.directory).toBe(join(userRoot, 'projects', projectSlug(repository), 'memory'));
  });

  it('keys a worktree on its container, so every branch shares one set of memories', async () => {
    const container = await scratch('b4m-memory-container-');
    const main = join(container, 'main');
    await run('git', ['init', '-q', main]);
    await run('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'first']);
    const branch = join(container, 'feat+thing');
    await run('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feat/thing', branch]);

    // An ordinary clone's common dir is <repo>/.git, so both of these answer <main>.
    const fromMain = await resolveMemoryStore(main, userRoot);
    const fromBranch = await resolveMemoryStore(branch, userRoot);
    expect(fromBranch.directory).toBe(fromMain.directory);
    expect(fromBranch.directory).toBe(join(userRoot, 'projects', projectSlug(main), 'memory'));
  });

  it('falls back to the directory itself when it is not a repository at all', async () => {
    const plain = await scratch();
    const resolved = await resolveMemoryStore(plain, userRoot);
    expect(resolved.directory).toBe(join(userRoot, 'projects', projectSlug(plain), 'memory'));
  });
});

describe('name validation', () => {
  it('takes a kebab-case slug', () => {
    expect(assertMemoryName('local-dev-server-port')).toBe('local-dev-server-port');
    expect(assertMemoryName('port3000')).toBe('port3000');
  });

  it.each(['../escape', 'a/b', '/etc/passwd', '.hidden', '', 'Name', 'name.md', 'two--hyphens', 'trailing-'])(
    'refuses %j',
    name => {
      expect(() => assertMemoryName(name)).toThrow(/not a memory name/);
    }
  );
});

describe('path containment', () => {
  let userRoot: string;
  let memory: MemoryStore;

  beforeEach(async () => {
    userRoot = await scratch('b4m-memory-user-');
    memory = await store(userRoot);
  });

  it('resolves a valid name inside the memory folder', async () => {
    expect(await resolveMemoryPath(memory, 'a-fact')).toBe(join(memory.directory, 'a-fact.md'));
  });

  it('refuses a symlink in the memory folder that points outside it', async () => {
    const outside = await scratch('b4m-memory-outside-');
    const secret = join(outside, 'secret.md');
    await writeFile(secret, 'not a memory', 'utf8');
    await symlink(secret, join(memory.directory, 'escape.md'));

    await expect(resolveMemoryPath(memory, 'escape')).rejects.toThrow(/does not resolve inside the memory folder/);
  });

  it('refuses a name that escapes before any path is built', async () => {
    await expect(resolveMemoryPath(memory, '../../CLAUDE')).rejects.toThrow(/not a memory name/);
  });
});

describe('the index', () => {
  it('adds one line, with the title and the hook', () => {
    const line = updateIndex('', 'a-fact', '- [A fact](a-fact.md) - the hook');
    expect(line).toBe('- [A fact](a-fact.md) - the hook\n');
  });

  it('replaces a memory line rather than adding a second, even when it was retitled', () => {
    const before = '- [Old title](a-fact.md) - old hook\n- [Other](other.md) - kept\n';
    const after = updateIndex(before, 'a-fact', '- [New title](a-fact.md) - new hook');
    expect(after.split('\n').filter(line => line.includes('(a-fact.md)'))).toHaveLength(1);
    expect(after).toContain('- [Other](other.md) - kept');
    expect(after).toContain('- [New title](a-fact.md) - new hook');
  });

  it('removes a line without touching its neighbours', () => {
    const before = '- [One](one.md) - a\n- [Two](two.md) - b\n';
    expect(updateIndex(before, 'one', null)).toBe('- [Two](two.md) - b\n');
  });

  it('removing a pointer that was never there is not an error', () => {
    expect(updateIndex('- [Two](two.md) - b\n', 'one', null)).toBe('- [Two](two.md) - b\n');
  });
});

describe('frontmatterValue', () => {
  it('reads a scalar out of the block', () => {
    const text = '---\nname: a-fact\ndescription: what it says\nmetadata:\n  type: project\n---\n\nthe fact\n';
    expect(frontmatterValue(text, 'description')).toBe('what it says');
    expect(frontmatterValue(text, 'name')).toBe('a-fact');
  });

  it('is undefined with no frontmatter, rather than reading the body', () => {
    expect(frontmatterValue('description: not frontmatter\n', 'description')).toBeUndefined();
  });
});

describe('write, read back and delete', () => {
  let userRoot: string;
  let memory: MemoryStore;

  beforeEach(async () => {
    userRoot = await scratch('b4m-memory-user-');
    memory = await store(userRoot);
  });

  const body = (name: string): string =>
    `---\nname: ${name}\ndescription: the one line hook\nmetadata:\n  type: project\n---\n\nthe fact\n`;

  it('round-trips a memory and adds exactly one index line', async () => {
    await save(memory, 'a-fact', body('a-fact'), 'A fact');

    expect(await readFile(join(memory.directory, 'a-fact.md'), 'utf8')).toBe(body('a-fact'));
    const index = await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8');
    expect(index).toBe('- [A fact](a-fact.md) - the one line hook\n');
  });

  it('takes the hook from the description when none is given', async () => {
    await save(memory, 'a-fact', body('a-fact'));
    const index = await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8');
    expect(index).toBe('- [A fact](a-fact.md) - the one line hook\n');
  });

  it('updating a memory leaves the index at one line', async () => {
    await save(memory, 'a-fact', body('a-fact'), 'A fact');
    await save(memory, 'a-fact', body('a-fact').replace('the fact', 'a better fact'), 'A fact');

    const index = await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8');
    expect(index.trim().split('\n')).toHaveLength(1);
    expect(await readFile(join(memory.directory, 'a-fact.md'), 'utf8')).toContain('a better fact');
  });

  it('deleting removes the file and its index line', async () => {
    await save(memory, 'a-fact', body('a-fact'), 'A fact');
    await save(memory, 'other', body('other'), 'Other');

    await applyMemoryPlan(await planMemoryDelete(memory, 'a-fact'));

    await expect(readFile(join(memory.directory, 'a-fact.md'), 'utf8')).rejects.toThrow();
    const index = await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8');
    expect(index).toBe('- [Other](other.md) - the one line hook\n');
  });

  it('refuses to delete a name that is neither a file nor a pointer', async () => {
    await expect(planMemoryDelete(memory, 'never-written')).rejects.toThrow(/no memory named/);
  });

  it('deletes a pointer whose file is already gone', async () => {
    await writeFile(join(memory.directory, MEMORY_INDEX_FILE), '- [Gone](gone.md) - stale\n', 'utf8');
    await applyMemoryPlan(await planMemoryDelete(memory, 'gone'));
    expect(await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8')).toBe('');
  });
});

describe('loading the index into the prompt', () => {
  let userRoot: string;
  let project: string;
  let memory: MemoryStore;

  beforeEach(async () => {
    userRoot = await scratch('b4m-memory-user-');
    project = await scratch();
    memory = await store(userRoot);
  });

  it('is its own scope, after the instruction blocks', async () => {
    await writeFile(join(project, 'CLAUDE.md'), 'project rules', 'utf8');
    await writeFile(join(memory.directory, MEMORY_INDEX_FILE), '- [A fact](a-fact.md) - the hook\n', 'utf8');

    const blocks = await loadInstructions(project, project, userRoot, memory);
    expect(blocks.map(block => block.scope)).toEqual(['project', 'memory']);
    expect(blocks[1].text).toContain('- [A fact](a-fact.md) - the hook');
  });

  it('is omitted when there is no index yet', async () => {
    await writeFile(join(project, 'CLAUDE.md'), 'project rules', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot, memory);
    expect(blocks.map(block => block.scope)).toEqual(['project']);
  });

  it('a memory file with no pointer does not break loading', async () => {
    await writeFile(join(memory.directory, 'orphan.md'), 'no pointer anywhere', 'utf8');
    const blocks = await loadInstructions(project, project, userRoot, memory);
    expect(blocks).toEqual([]);
  });

  it('never loads the memories themselves, only the index', async () => {
    await save(memory, 'a-fact', '---\nname: a-fact\ndescription: hook\n---\n\nthe secret body\n', 'A fact');
    const blocks = await loadInstructions(project, project, userRoot, memory);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toContain('the secret body');
  });

  it('shares the instruction budget rather than adding an allowance of its own', async () => {
    const filler = (label: string, lines: number): string =>
      Array.from({ length: lines }, (_, i) => `${label} line ${i + 1} ${'x'.repeat(20)}`).join('\n');
    await writeFile(join(project, 'CLAUDE.md'), filler('p', 4_000), 'utf8');
    await writeFile(join(memory.directory, MEMORY_INDEX_FILE), filler('m', 4_000), 'utf8');

    const blocks = await loadInstructions(project, project, userRoot, memory);
    const total = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
    // Each block's own truncation notice sits outside the budget; a small allowance for them.
    expect(total).toBeLessThan(MAX_INSTRUCTIONS_BYTES + 2_000);
  });

  it('is the block the budget cuts first, so instructions keep their bytes', async () => {
    const filler = (label: string, lines: number): string =>
      Array.from({ length: lines }, (_, i) => `${label} line ${i + 1} ${'x'.repeat(20)}`).join('\n');
    await writeFile(join(project, 'CLAUDE.md'), filler('p', 8_000), 'utf8');
    await writeFile(join(memory.directory, MEMORY_INDEX_FILE), '- [A fact](a-fact.md) - the hook\n', 'utf8');

    const blocks = await loadInstructions(project, project, userRoot, memory);
    expect(blocks.map(block => block.scope)).toEqual(['project']);
  });

  it('points a truncated index at memory_read, not at file_read it can never use', async () => {
    const line = (i: number): string => `- [Memory ${i}](memory-${i}.md) - ${'hook '.repeat(10)}`;
    const index = Array.from({ length: 2_000 }, (_, i) => line(i)).join('\n');
    await writeFile(join(memory.directory, MEMORY_INDEX_FILE), index, 'utf8');

    const blocks = await loadInstructions(project, project, userRoot, memory);
    expect(blocks[0].text).toContain('memory_read still reaches any memory by its name');
    expect(blocks[0].text).not.toContain('file_read');
  });
});
