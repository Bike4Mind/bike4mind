import { describe, it, expect, vi } from 'vitest';
import { CHAT_MESSAGE_WITHHELD_FIELDS, type IChatHistoryItemDocument, type ITurnTiming } from '@bike4mind/common';
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
  it.each([false, true])('withholds server-only fields with full payload mode %s', async skipPayloadOptimization => {
    const { manager, sendToClient } = setup();
    const quest = makeQuest({
      reply: 'Visible answer',
      ...Object.fromEntries(CHAT_MESSAGE_WITHHELD_FIELDS.map(field => [field, { privateValue: field }])),
    });
    await manager.sendStatusUpdate(quest, 'done', { skipPayloadOptimization });
    const sentQuest = sendToClient.mock.calls[0][2].quest as Record<string, unknown>;
    expect(sentQuest.reply).toBe('Visible answer');
    for (const field of CHAT_MESSAGE_WITHHELD_FIELDS) {
      expect(sentQuest).not.toHaveProperty(field);
      expect(quest).toHaveProperty(field);
    }
  });
  it('carries videoJobIds so the client can render a card per job', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest({ videoJobIds: ['a'] }), 'working');
    expect(sendToClient.mock.calls[0][2].quest.videoJobIds).toEqual(['a']);
  });

  it('carries generationJobs so the client can render a card per job', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest({ generationJobs: [{ id: 'm', kind: 'music' }] }), 'working');
    expect(sendToClient.mock.calls[0][2].quest.generationJobs).toEqual([{ id: 'm', kind: 'music' }]);
  });

  it('omits videoJobIds and generationJobs when the quest has none', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest(), 'working');
    expect(sendToClient.mock.calls[0][2].quest).not.toHaveProperty('videoJobIds');
    expect(sendToClient.mock.calls[0][2].quest).not.toHaveProperty('generationJobs');
  });

  it('carries an empty citables array so withdrawn source chips clear mid-stream', async () => {
    const { manager, sendToClient } = setup();
    const quest = makeQuest({ promptMeta: { citables: [] } } as Partial<IChatHistoryItemDocument>);
    await manager.sendStatusUpdate(quest, 'working');
    // An omitted promptMeta would leave the client's last non-empty chips in place for the stream.
    expect(sendToClient.mock.calls[0][2].quest.promptMeta).toEqual({ citables: [] });
  });

  it('omits promptMeta when the quest carries neither citables nor artifacts', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest({ promptMeta: {} } as Partial<IChatHistoryItemDocument>), 'working');
    expect(sendToClient.mock.calls[0][2].quest).not.toHaveProperty('promptMeta');
  });

  it('carries turnTiming so a retried reply shows its footnote mid-stream', async () => {
    const { manager, sendToClient } = setup();
    const turnTiming: ITurnTiming = {
      queueMs: 120,
      semaphoreWaitMs: 0,
      retries: [{ reason: 'stream_idle_timeout', delayMs: 3000, model: 'm', at: new Date() }],
      fallbackHops: 0,
    };
    await manager.sendStatusUpdate(makeQuest({ turnTiming }), 'working');

    expect(sendToClient.mock.calls[0][2].quest.turnTiming).toMatchObject({
      queueMs: 120,
      retries: [expect.any(Object)],
    });
  });

  it('omits turnTiming when the quest has none', async () => {
    const { manager, sendToClient } = setup();
    await manager.sendStatusUpdate(makeQuest(), 'working');

    expect(sendToClient.mock.calls[0][2].quest).not.toHaveProperty('turnTiming');
  });
});
