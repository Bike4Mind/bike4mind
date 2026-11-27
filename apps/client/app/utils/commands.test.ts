import { describe, it, expect, vi } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { chatImageSendMode, extractCommandAndParams, handleCommand, type CommandHandlers } from './commands';
import { terminalQuests } from '../hooks/chatCompletionState';

describe('handleCommand - re-running an existing quest', () => {
  it('clears the terminal mark so the re-run stream is not dropped as stale', async () => {
    terminalQuests.markTerminal('rerun-q', undefined);
    expect(terminalQuests.isStaleFrame('rerun-q', 'running')).toBe(true);

    const handler = vi.fn().mockResolvedValue(undefined);
    await handleCommand(
      { '/llm': handler } as CommandHandlers,
      {
        userId: 'u1',
        command: '/llm',
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
      { '/llm': vi.fn().mockResolvedValue(undefined) } as CommandHandlers,
      {
        userId: 'u1',
        command: '/llm',
        params: 'a dog',
      } as Parameters<typeof handleCommand>[1]
    );

    expect(terminalQuests.isStaleFrame('other-q', 'running')).toBe(true);
  });
});

describe('chatImageSendMode', () => {
  const IMAGE_MODEL = ImageModels.GPT_IMAGE_2;
  const TEXT_MODEL = 'gpt-4o';

  it('makes an image-model send a chat image generation, and a text-model send not one', () => {
    expect(chatImageSendMode(true, IMAGE_MODEL, 'a lighthouse')).toBe('generate');
    expect(chatImageSendMode(true, TEXT_MODEL, 'a lighthouse')).toBeUndefined();
  });

  it('makes an image edit a chat image edit, whatever the model', () => {
    expect(chatImageSendMode(true, TEXT_MODEL, 'make it red', true)).toBe('edit');
  });

  it('leaves a typed command, or a send with live AI off, to the command path', () => {
    expect(chatImageSendMode(true, IMAGE_MODEL, '/roll 2d6')).toBeUndefined();
    expect(chatImageSendMode(false, IMAGE_MODEL, 'a lighthouse')).toBeUndefined();
  });
});

describe('extractCommandAndParams', () => {
  it('sends a plain prompt as /llm with its history and context prefixes', () => {
    expect(extractCommandAndParams(true, 'gpt-4o', 5, 'hello', ['notes.md'])).toEqual([
      '/llm',
      '[Context:notes.md] [History:5] hello',
    ]);
  });

  it('treats the retired /gen_image like any other unknown slash text', () => {
    expect(extractCommandAndParams(true, 'gpt-4o', 5, '/gen_image a cat', [])).toEqual([
      '/llm',
      '[History:5] /gen_image a cat',
    ]);
    expect(extractCommandAndParams(false, 'gpt-4o', 5, '/gen_image a cat', [])).toEqual(['/gen_image', 'a cat']);
  });
});
