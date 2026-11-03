import { describe, expect, it } from 'vitest';
import { canFollowWithToolChange, diffToolNames, toolChangeContent } from './deferredTools';
import { ToolChangeMessageContentSchema } from './schemas/cliCompletions';

describe('diffToolNames', () => {
  it('lists additions and removals sorted by name', () => {
    expect(diffToolNames(['b', 'a', 'keep'], ['keep', 'd', 'c'])).toEqual({ added: ['c', 'd'], removed: ['a', 'b'] });
  });

  it('is empty for the same set in another order', () => {
    expect(diffToolNames(['a', 'b'], ['b', 'a'])).toEqual({ added: [], removed: [] });
  });
});

describe('toolChangeContent', () => {
  it('puts removals first and passes the proxy schema', () => {
    const content = toolChangeContent(['web'], ['file_read']);
    expect(content.map(block => `${block.type}:${block.tool.name}`)).toEqual([
      'tool_removal:file_read',
      'tool_addition:web',
    ]);
    expect(ToolChangeMessageContentSchema.safeParse(content).success).toBe(true);
  });
});

describe('canFollowWithToolChange', () => {
  const roles = (...list: string[]) => list.map(role => ({ role }));

  it('allows a user turn that is last or followed by an assistant turn', () => {
    expect(canFollowWithToolChange(roles('user'), 0)).toBe(true);
    expect(canFollowWithToolChange(roles('user', 'assistant'), 0)).toBe(true);
  });

  it('refuses an assistant turn, a user turn followed by a user turn, and out of range', () => {
    expect(canFollowWithToolChange(roles('user', 'assistant'), 1)).toBe(false);
    expect(canFollowWithToolChange(roles('user', 'user'), 0)).toBe(false);
    expect(canFollowWithToolChange(roles('user'), 1)).toBe(false);
  });
});
