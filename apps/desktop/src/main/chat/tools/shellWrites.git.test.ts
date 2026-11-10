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

  it.each(['status', 'log', 'diff'])('reads `git %s` as writing nothing', async sub => {
    const writes = await inPlaceWrites(['git', sub], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
  });
});
