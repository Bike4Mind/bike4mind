import { describe, expect, it } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { inPlaceWrites } from './shellWrites';

// The git subcommand branches read no syntax node.
const noNode = null as unknown as Node;

describe('git write scan on a subcommand word that is not plain text', () => {
  it.each(['cle?n', 'cle[a]n', 'cl$x', 'cl`x`', 'c{l,}ean', 'c\\lean', "cle''an", 'cle"an"', '*', '?'])(
    'leaves the paths of `git %s -fdx` unread',
    async sub => {
      const writes = await inPlaceWrites(['git', sub, '-fdx'], noNode, '/nonexistent/project');
      expect(writes.unread).toBe(true);
    }
  );

  it.each(['-C . ', '-c core.pager=cat ', '--no-pager '])(
    'leaves the paths of `git %scle?n -fdx` unread',
    async options => {
      const writes = await inPlaceWrites(
        ['git', ...options.trim().split(' '), 'cle?n', '-fdx'],
        noNode,
        '/nonexistent/project'
      );
      expect(writes.unread).toBe(true);
    }
  );

  it.each([
    ['--git-dir', 'main'],
    ['--work-tree', 'main'],
    ['--namespace', 'main'],
    ['--config-env', 'core.x=main'],
    ['--attr-source', 'main'],
    ['--attr-source', 'HEAD'],
    ['--super-prefix', 'main'],
    ['--shallow-file', 'main'],
  ])(
    'leaves the paths of `git %s %s clean -fdx` unread, as a separate value and as a glued one',
    async (option, value) => {
      for (const words of [
        [option, value],
        [`${option}=${value}`],
        ['-C', '.', option, value],
        ['-c', 'core.x=y', option, value],
      ]) {
        const writes = await inPlaceWrites(['git', ...words, 'clean', '-fdx'], noNode, '/nonexistent/project');
        expect(writes.unread).toBe(true);
      }
    }
  );

  it.each([
    ['--future-option', 'main'],
    ['--no-pager', 'HEAD'],
    ['--no-pager', './x'],
    ['--bare', 'Main'],
  ])('leaves the paths of `git %s %s clean -fdx` unread, as a word that is no command name', async (option, word) => {
    const writes = await inPlaceWrites(['git', option, word, 'clean', '-fdx'], noNode, '/nonexistent/project');
    expect(writes.unread).toBe(true);
  });

  it.each(['--version', '-v', '--help', '-h'])('reads `git %s clean -fdx` as writing nothing', async option => {
    const writes = await inPlaceWrites(['git', option, 'clean', '-fdx'], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
    expect(writes.files).toEqual([]);
  });

  it.each([
    ['--no-pager'],
    ['-C', '.'],
    ['-c', 'core.x=y'],
    ['--exec-path'],
    ['--no-literal-pathspecs'],
    ['--literal-pathspecs'],
    ['--glob-pathspecs'],
    ['--noglob-pathspecs'],
    ['--icase-pathspecs'],
    ['--no-replace-objects'],
    ['--no-lazy-fetch'],
    ['--no-advice'],
    ['--no-optional-locks'],
  ])('reads `git %s status` as writing nothing', async (...words) => {
    const writes = await inPlaceWrites(['git', ...words, 'status'], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
  });

  it.each(['status', 'log', 'diff'])('reads `git %s` as writing nothing', async sub => {
    const writes = await inPlaceWrites(['git', sub], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
  });
});
