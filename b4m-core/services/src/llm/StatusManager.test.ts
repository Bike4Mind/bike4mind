import { describe, it, expect, vi } from 'vitest';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ClientMessageSender } from '@bike4mind/utils';
import { StatusManager } from './StatusManager';

function setup() {
  const sendToClient = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() } as unknown as Logger;
  const manager = new StatusManager(
    { sendToClient } as unknown as ClientMessageSender,
    logger,
    'https://ws.example.test',
    'user-1'
  );
  return { manager, sendToClient };
}

const makeQuest = (overrides: Partial<IChatHistoryItemDocument> = {}) => ({
  id: 'q1',
  sessionId: 's1',
  ...overrides,
});

describe('StatusManager minimal payload', () => {
  it('carries videoJobIds so the client can render a card per job', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest({ videoJobIds: ['a'] }), 'working');
    expect(sendToClient.mock.calls[0][2].quest.videoJobIds).toEqual(['a']);
  });

  it('omits videoJobIds when the quest has none', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest(), 'working');
    expect(sendToClient.mock.calls[0][2].quest).not.toHaveProperty('videoJobIds');
  });
});
