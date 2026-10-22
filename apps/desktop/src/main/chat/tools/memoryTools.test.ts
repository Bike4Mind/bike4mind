import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_INDEX_FILE, type MemoryStore } from '../project/memory';
import { memoryDelete, memoryRead, memoryWrite } from './memoryTools';
import type { ToolContext } from './types';

async function scratch(prefix = 'b4m-memtool-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

const BODY = '---\nname: a-fact\ndescription: the one line hook\nmetadata:\n  type: project\n---\n\nthe fact\n';

describe('the memory tools', () => {
  let memory: MemoryStore;
  let context: ToolContext;

  beforeEach(async () => {
    // A temp instructions root, never the real one: the user's own memories live under ~/.claude.
    const userRoot = await scratch('b4m-memtool-user-');
    const directory = join(userRoot, 'projects', 'project', 'memory');
    await mkdir(directory, { recursive: true });
    memory = { directory, userInstructionsRoot: userRoot };
    context = { roots: [], signal: new AbortController().signal, memory };
  });

  it('refuses every call when the conversation has no store', async () => {
    const bare: ToolContext = { roots: [], signal: new AbortController().signal };
    await expect(memoryRead.run({ name: 'a-fact' }, bare)).rejects.toThrow(/no memory store/);
    await expect(memoryWrite.run({ name: 'a-fact', content: BODY }, bare)).rejects.toThrow(/no memory store/);
  });

  it('writes a memory, its pointer, and reads it back by name', async () => {
    const result = await memoryWrite.run({ name: 'a-fact', content: BODY, title: 'A fact' }, context);
    expect(result).toContain('Saved the memory a-fact');

    expect(await memoryRead.run({ name: 'a-fact' }, context)).toBe(BODY);
    expect(await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8')).toBe(
      '- [A fact](a-fact.md) - the one line hook\n'
    );
  });

  it('shows the user both files before writing either', async () => {
    const prompt = await memoryWrite.approval?.({ name: 'a-fact', content: BODY, title: 'A fact' }, context);
    expect(prompt?.diffs?.map(diff => diff.path)).toEqual([
      join(memory.directory, 'a-fact.md'),
      join(memory.directory, MEMORY_INDEX_FILE),
    ]);
    // The prompt reads the folder; nothing is written until the user has answered.
    await expect(readFile(join(memory.directory, 'a-fact.md'), 'utf8')).rejects.toThrow();
  });

  it('reports a second write as an update, with the index still at one line', async () => {
    await memoryWrite.run({ name: 'a-fact', content: BODY, title: 'A fact' }, context);
    const result = await memoryWrite.run(
      { name: 'a-fact', content: BODY.replace('the fact', 'more'), title: 'A fact' },
      context
    );

    expect(result).toContain('Updated the memory a-fact');
    const index = await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8');
    expect(index.trim().split('\n')).toHaveLength(1);
  });

  it('deletes the file and the pointer together', async () => {
    await memoryWrite.run({ name: 'a-fact', content: BODY, title: 'A fact' }, context);
    expect(await memoryDelete.run({ name: 'a-fact' }, context)).toContain('Deleted the memory a-fact');

    await expect(memoryRead.run({ name: 'a-fact' }, context)).rejects.toThrow(/no memory named/);
    expect(await readFile(join(memory.directory, MEMORY_INDEX_FILE), 'utf8')).toBe('');
  });

  it('reads a memory whose pointer was never written', async () => {
    await writeFile(join(memory.directory, 'orphan.md'), 'no pointer anywhere\n', 'utf8');
    expect(await memoryRead.run({ name: 'orphan' }, context)).toBe('no pointer anywhere\n');
  });

  it.each(['../escape', 'a/b', '/etc/passwd', '.hidden'])('refuses the name %j', async name => {
    await expect(memoryRead.run({ name }, context)).rejects.toThrow(/not a memory name/);
    await expect(memoryWrite.run({ name, content: BODY }, context)).rejects.toThrow(/not a memory name/);
  });

  it('refuses a symlinked memory pointing out of the folder, on the write as well as the read', async () => {
    const outside = await scratch('b4m-memtool-outside-');
    await writeFile(join(outside, 'target.md'), 'elsewhere\n', 'utf8');
    await symlink(join(outside, 'target.md'), join(memory.directory, 'escape.md'));

    await expect(memoryRead.run({ name: 'escape' }, context)).rejects.toThrow(/inside the memory folder/);
    await expect(memoryWrite.run({ name: 'escape', content: BODY }, context)).rejects.toThrow(
      /inside the memory folder/
    );
    expect(await readFile(join(outside, 'target.md'), 'utf8')).toBe('elsewhere\n');
  });
});
