import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { sendPromptViaComposer } from './sendPromptViaComposer';

const t = ((_key: string, fallback: string) => fallback) as unknown as TFunction;

describe('sendPromptViaComposer', () => {
  it('does not call handleSendClick and resolves false when a reason blocks the send', async () => {
    const handleSendClick = vi.fn();
    const toastInfo = vi.fn();
    const shouldToastBlockedSend = vi.fn().mockReturnValue(true);

    const sent = await sendPromptViaComposer({
      prompt: '2) Extend',
      sendBlockedReason: 'uploading',
      shouldToastBlockedSend,
      toastInfo,
      t,
      handleSendClick,
    });

    expect(sent).toBe(false);
    expect(handleSendClick).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('Uploading files...');
  });

  it('does not toast a second time within the gate window', async () => {
    const handleSendClick = vi.fn();
    const toastInfo = vi.fn();
    const shouldToastBlockedSend = vi.fn().mockReturnValue(false);

    await sendPromptViaComposer({
      sendBlockedReason: 'reconnecting',
      shouldToastBlockedSend,
      toastInfo,
      t,
      handleSendClick,
    });

    expect(toastInfo).not.toHaveBeenCalled();
    expect(handleSendClick).not.toHaveBeenCalled();
  });

  it('sends the prompt through handleSendClick when nothing blocks it', async () => {
    const handleSendClick = vi.fn().mockResolvedValue(undefined);
    const sent = await sendPromptViaComposer({
      prompt: '2) Extend',
      sendBlockedReason: null,
      shouldToastBlockedSend: vi.fn(),
      toastInfo: vi.fn(),
      t,
      handleSendClick,
    });

    expect(sent).toBe(true);
    expect(handleSendClick).toHaveBeenCalledWith('2) Extend', { onRefused: expect.any(Function) });
  });

  it('ignores shouldToastBlockedSend entirely when sendBlockedReason is null - the ungated, chess-style caller', async () => {
    const handleSendClick = vi.fn().mockResolvedValue(undefined);
    const shouldToastBlockedSend = vi.fn().mockReturnValue(true);
    const toastInfo = vi.fn();

    const sent = await sendPromptViaComposer({
      prompt: 'I play e4 [FEN: ...]',
      sendBlockedReason: null,
      shouldToastBlockedSend,
      toastInfo,
      t,
      handleSendClick,
    });

    expect(sent).toBe(true);
    expect(shouldToastBlockedSend).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(handleSendClick).toHaveBeenCalledWith('I play e4 [FEN: ...]', { onRefused: expect.any(Function) });
  });

  it('resolves false when handleSendClick reports the send as refused', async () => {
    const handleSendClick = vi.fn(async (_prompt?: string, options?: { onRefused?: () => void }) => {
      options?.onRefused?.();
      return undefined;
    });

    const sent = await sendPromptViaComposer({
      prompt: '2) Extend',
      sendBlockedReason: null,
      shouldToastBlockedSend: vi.fn(),
      toastInfo: vi.fn(),
      t,
      handleSendClick,
    });

    expect(sent).toBe(false);
  });
});
