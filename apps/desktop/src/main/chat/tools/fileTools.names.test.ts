import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ripgrepSearch = vi.hoisted(() => vi.fn());
const listed = vi.hoisted(() => ({ tracked: '' }));
vi.mock('./ripgrep', () => ({ ripgrepSearch }));
vi.mock('../project/git', () => ({
  git: async (_directory: string, args: readonly string[]) => {
    if (args.includes('--ignored') || !listed.tracked) throw new Error('not a repository');
    return listed.tracked;
  },
}));

import { globFiles, grepSearch } from './fileTools';
import type { ToolContext } from './types';

// Windows names cannot hold `?` or `:`, so this is a Linux and macOS case.
describe.skipIf(process.platform === 'win32')('names holding ? or : in a folder that is not in WSL', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-hostnames-')));
    context = { roots: [root], signal: new AbortController().signal };
    await writeFile(join(root, 'x?y.txt'), 'needle one\n', 'utf8');
    await writeFile(join(root, 'a:b.txt'), 'needle two\n', 'utf8');
    listed.tracked = 'x?y.txt\0a:b.txt\0';
    ripgrepSearch.mockReset().mockResolvedValue('unavailable');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists and greps a listed name as it is spelled on disk', async () => {
    const glob = await globFiles.run({ pattern: '*', path: root }, context);
    const grep = await grepSearch.run({ pattern: 'needle', path: root }, context);

    for (const output of [glob, grep]) {
      expect(output).toContain('x?y.txt');
      expect(output).toContain('a:b.txt');
    }
    expect(grep).toContain('needle one');
    expect(grep).toContain('needle two');
  });

  it('shows a name ripgrep printed as it printed it, and filters by that name', async () => {
    ripgrepSearch.mockImplementation(async ({ onFile }) => {
      onFile({ path: 'a:b.txt', matches: 1, lines: [{ number: 1, text: 'needle two', match: true }] });
      onFile({ path: 'x?y.txt', matches: 1, lines: [{ number: 1, text: 'needle one', match: true }] });
      return 'done';
    });

    const result = await grepSearch.run(
      { pattern: 'needle', path: root, outputMode: 'files', include: 'a:*' },
      context
    );

    expect(result).toContain('a:b.txt');
    expect(result).not.toContain('x?y.txt');
  });
});
