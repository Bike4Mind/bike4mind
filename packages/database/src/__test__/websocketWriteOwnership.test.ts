import { describe, it, expect } from 'vitest';
import { ActiveCodeAgent, activeCodeAgentRepository } from '../models/ai/ActiveCodeAgentModel';
import { Quest, questRepository } from '../models/content/QuestModel';
import { setupMongoTest } from './utils';

/**
 * The two WebSocket write paths whose upsert key used to omit the owner. Both are exercised
 * against a real database because the property being pinned is the FILTER Mongo matches on -
 * a mocked repository would assert the code we wrote rather than what the driver does with it.
 */
describe('activeCodeAgentRepository.upsertOnRegister ownership', () => {
  setupMongoTest();

  const register = (userId: string, overrides: Record<string, unknown> = {}) =>
    activeCodeAgentRepository.upsertOnRegister({
      userId,
      deviceId: `device-${userId}`,
      instanceId: 'shared-instance',
      connectionId: `conn-${userId}`,
      workspaceName: `ws-${userId}`,
      workspacePath: `/home/${userId}/ws`,
      spriteId: 'knight',
      position: { x: 1, y: 2 },
      startedAt: new Date(),
      ...overrides,
    });

  it('is idempotent for the owner, as bridge reconnects rely on', async () => {
    await register('owner');
    const again = await register('owner', { connectionId: 'conn-owner-2' });

    expect(again.connectionId).toBe('conn-owner-2');
    expect(await ActiveCodeAgent.countDocuments({ instanceId: 'shared-instance' })).toBe(1);
  });

  it('does not let a second user take over a live session record', async () => {
    const original = await register('owner');

    await expect(register('attacker')).rejects.toThrow(/registered to another user/);

    // Not merely "unchanged": no second row either. An earlier draft of this fix leaned on the
    // unique index to reject the attacker's insert, and this assertion is what showed that the
    // index is not built in time to be load-bearing.
    expect(await ActiveCodeAgent.countDocuments({ instanceId: 'shared-instance' })).toBe(1);
    const after = await ActiveCodeAgent.findOne({ instanceId: 'shared-instance' }).lean();
    expect(after?.userId).toBe('owner');
    expect(after?.deviceId).toBe(original.deviceId);
    expect(after?.connectionId).toBe(original.connectionId);
  });
});

describe('questRepository.upsertVoiceTranscriptTurn ownership', () => {
  setupMongoTest();

  const turn = (userId: string, text: string) =>
    questRepository.upsertVoiceTranscriptTurn('session-1', 'item-1', userId, {
      prompt: text,
      status: 'done',
      type: 'voice_transcript',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the voice handler's exact partial write
    } as any);

  it('stamps the owner onto the row it inserts', async () => {
    const inserted = await turn('owner', 'hello');

    expect(inserted?.promptMeta?.session?.userId).toBe('owner');
    expect(inserted?.promptMeta?.session?.id).toBe('session-1');
  });

  it('updates the owner own turn in place rather than duplicating it', async () => {
    await turn('owner', 'first');
    await turn('owner', 'corrected');

    const rows = await Quest.find({ sessionId: 'session-1', conversationItemId: 'item-1' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe('corrected');
  });

  it('does not let a co-editor overwrite another user turn by reusing its conversationItemId', async () => {
    await turn('owner', 'what the owner said');
    await turn('attacker', 'what the attacker wants it to say');

    const ownerRow = await Quest.findOne({
      sessionId: 'session-1',
      conversationItemId: 'item-1',
      'promptMeta.session.userId': 'owner',
    }).lean();
    expect(ownerRow?.prompt).toBe('what the owner said');
  });
});
