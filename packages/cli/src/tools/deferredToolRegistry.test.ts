import { beforeEach, describe, expect, it } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { deferredToolRegistry } from './deferredToolRegistry.js';

const makeTool = (name: string, description = ''): ICompletionOptionTools => ({
  toolSchema: {
    name,
    description,
    parameters: { type: 'object', properties: {} },
  },
  toolFn: async () => 'noop',
});

describe('deferredToolRegistry', () => {
  beforeEach(() => {
    deferredToolRegistry.clear();
  });

  it('register replaces previous contents and tracks size', () => {
    deferredToolRegistry.register([makeTool('a'), makeTool('b')]);
    expect(deferredToolRegistry.size()).toBe(2);
    deferredToolRegistry.register([makeTool('c')]);
    expect(deferredToolRegistry.size()).toBe(1);
    expect(deferredToolRegistry.has('a')).toBe(false);
    expect(deferredToolRegistry.has('c')).toBe(true);
  });

  it('getByNames returns matches in input order and skips unknown names', () => {
    deferredToolRegistry.register([makeTool('alpha'), makeTool('beta'), makeTool('gamma')]);
    const result = deferredToolRegistry.getByNames(['gamma', 'unknown', 'alpha']);
    expect(result.map(t => t.toolSchema.name)).toEqual(['gamma', 'alpha']);
  });

  it('searchByKeywords ranks name matches above description matches', () => {
    deferredToolRegistry.register([
      makeTool('mcp__github__create_pull_request', 'opens a PR'),
      makeTool('mcp__github__list_issues', 'lists issues with optional pull request context'),
      makeTool('mcp__slack__send_message', 'sends a slack message'),
    ]);
    const result = deferredToolRegistry.searchByKeywords('pull request', 10);
    expect(result[0].toolSchema.name).toBe('mcp__github__create_pull_request');
    expect(result.map(t => t.toolSchema.name)).toContain('mcp__github__list_issues');
    expect(result.map(t => t.toolSchema.name)).not.toContain('mcp__slack__send_message');
  });

  it('searchByKeywords returns empty for unmatched query', () => {
    deferredToolRegistry.register([makeTool('alpha', 'unrelated')]);
    expect(deferredToolRegistry.searchByKeywords('zzz nothing', 5)).toEqual([]);
  });

  it('searchByKeywords respects maxResults', () => {
    deferredToolRegistry.register([makeTool('foo_a', 'desc'), makeTool('foo_b', 'desc'), makeTool('foo_c', 'desc')]);
    expect(deferredToolRegistry.searchByKeywords('foo', 2).length).toBe(2);
  });

  it('getDirectoryNames returns sorted names', () => {
    deferredToolRegistry.register([makeTool('charlie'), makeTool('alpha'), makeTool('bravo')]);
    expect(deferredToolRegistry.getDirectoryNames()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('getDirectoryNames returns a defensive copy (caller mutation does not leak)', () => {
    deferredToolRegistry.register([makeTool('alpha'), makeTool('bravo')]);
    const first = deferredToolRegistry.getDirectoryNames();
    first.push('injected');
    expect(deferredToolRegistry.getDirectoryNames()).toEqual(['alpha', 'bravo']);
  });

  // #213: the directory is a frozen snapshot from register(), decoupled from
  // the live tool map. If a tool is evicted from `byName` mid-session (e.g. a
  // future load-eviction optimization), the cache-stamped system-prompt
  // directory must NOT change a byte. Simulate eviction via the private map.
  it('getDirectoryNames stays byte-stable when the live tool map diverges', () => {
    deferredToolRegistry.register([makeTool('alpha'), makeTool('bravo'), makeTool('charlie')]);
    const before = deferredToolRegistry.getDirectoryNames();

    (deferredToolRegistry as unknown as { byName: Map<string, unknown> }).byName.delete('bravo');

    expect(deferredToolRegistry.has('bravo')).toBe(false);
    expect(deferredToolRegistry.getDirectoryNames()).toEqual(before);
  });
});
