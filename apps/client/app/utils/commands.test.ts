import { describe, it, expect, vi } from 'vitest';
import { handleCommand, type CommandHandlers } from './commands';
import { terminalQuests } from '../hooks/chatCompletionState';

describe('handleCommand - re-running an existing quest', () => {
  it('clears the terminal mark so the re-run stream is not dropped as stale', async () => {
    terminalQuests.markTerminal('rerun-q', undefined);
    expect(terminalQuests.isStaleFrame('rerun-q', 'running')).toBe(true);

    const handler = vi.fn().mockResolvedValue(undefined);
    await handleCommand(
      { '/gen_image': handler } as CommandHandlers,
      {
        userId: 'u1',
        command: '/gen_image',
        params: 'a cat',
        questId: 'rerun-q',
      } as Parameters<typeof handleCommand>[1]
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(terminalQuests.isStaleFrame('rerun-q', 'running')).toBe(false);
  });

  it('leaves marks alone for a new turn (no questId)', async () => {
    terminalQuests.markTerminal('other-q', undefined);
    await handleCommand(
      { '/gen_image': vi.fn().mockResolvedValue(undefined) } as CommandHandlers,
      {
        userId: 'u1',
        command: '/gen_image',
        params: 'a dog',
      } as Parameters<typeof handleCommand>[1]
    );

    expect(terminalQuests.isStaleFrame('other-q', 'running')).toBe(true);
  });
});
