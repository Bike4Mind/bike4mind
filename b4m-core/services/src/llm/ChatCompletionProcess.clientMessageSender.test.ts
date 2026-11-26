import { describe, expect, it, vi } from 'vitest';
import { ChatCompletionProcess } from './ChatCompletionProcess';

const { websocketSend } = vi.hoisted(() => ({ websocketSend: vi.fn() }));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    ClientMessageSender: class {
      sendToClient = websocketSend;
    },
  };
});

type Quest = Parameters<ChatCompletionProcess['sendStatusUpdate']>[0];

const quest = { id: 'quest-1', sessionId: 'session-1', replies: ['hi'], status: 'running' } as unknown as Quest;

function makeService(clientMessageSender?: { sendToClient: ReturnType<typeof vi.fn> }) {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  // The options are a wide host-wiring bag; the status path reads only these.
  return new ChatCompletionProcess({
    logger,
    wsHttpsUrl: 'wss://example.test',
    user: { id: 'user1' },
    db: {},
    clientMessageSender,
  } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);
}

describe('ChatCompletionProcess client frame sender', () => {
  it('sends status frames through the injected sender instead of a websocket sender of its own', async () => {
    const injected = { sendToClient: vi.fn().mockResolvedValue(undefined) };
    const service = makeService(injected);

    // The first update only builds the status manager; the second sends.
    await service.sendStatusUpdate(quest, 'Working');
    await service.sendStatusUpdate(quest, 'Still working');

    expect(injected.sendToClient).toHaveBeenCalledWith(
      'user1',
      'wss://example.test',
      expect.objectContaining({ action: 'streamed_chat_completion' })
    );
    expect(websocketSend).not.toHaveBeenCalled();
  });

  it('falls back to its own websocket sender when none is injected', async () => {
    websocketSend.mockResolvedValue(undefined);
    const service = makeService();

    await service.sendStatusUpdate(quest, 'Working');
    await service.sendStatusUpdate(quest, 'Still working');

    expect(websocketSend).toHaveBeenCalled();
  });
});
