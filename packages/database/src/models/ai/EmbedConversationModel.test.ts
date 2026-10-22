import { describe, it, expect, beforeEach } from 'vitest';
import EmbedConversationModel, {
  embedConversationRepository as repo,
  EMBED_CONVERSATION_MAX_MESSAGES,
} from './EmbedConversationModel';
import { setupMongoTest } from '../../__test__/utils';

const USER = 'user-1';
const AGENT = 'agent-1';
const KEY = 'key-1';

describe('EmbedConversationRepository', () => {
  setupMongoTest();
  beforeEach(async () => {
    await EmbedConversationModel.ensureIndexes();
  });

  it('returns no messages before the user has chatted', async () => {
    expect(await repo.getMessages(USER, AGENT)).toEqual([]);
  });

  it('upserts on the first turn and appends later turns in order', async () => {
    await repo.appendMessages(USER, AGENT, KEY, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    await repo.appendMessages(USER, AGENT, KEY, [
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'welcome back' },
    ]);

    const messages = await repo.getMessages(USER, AGENT);
    expect(messages.map(m => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
      ['user', 'again'],
      ['assistant', 'welcome back'],
    ]);
    expect(await EmbedConversationModel.countDocuments({ userId: USER, agentId: AGENT })).toBe(1);
  });

  it('scopes history to one user and one agent', async () => {
    await repo.appendMessages(USER, AGENT, KEY, [{ role: 'user', content: 'mine' }]);

    expect(await repo.getMessages('user-2', AGENT)).toEqual([]);
    expect(await repo.getMessages(USER, 'agent-2')).toEqual([]);
  });

  it('keeps only the newest messages past the cap', async () => {
    const turns = Array.from({ length: EMBED_CONVERSATION_MAX_MESSAGES + 4 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    await repo.appendMessages(USER, AGENT, KEY, turns);

    const messages = await repo.getMessages(USER, AGENT);
    expect(messages).toHaveLength(EMBED_CONVERSATION_MAX_MESSAGES);
    expect(messages[0].content).toBe('m4');
  });

  it('erases one conversation, or every conversation for a user', async () => {
    await repo.appendMessages(USER, AGENT, KEY, [{ role: 'user', content: 'a' }]);
    await repo.appendMessages(USER, 'agent-2', KEY, [{ role: 'user', content: 'b' }]);
    await repo.appendMessages('user-2', AGENT, KEY, [{ role: 'user', content: 'c' }]);

    await repo.deleteConversation(USER, AGENT);
    expect(await repo.getMessages(USER, AGENT)).toEqual([]);
    expect(await repo.getMessages(USER, 'agent-2')).toHaveLength(1);

    expect(await repo.deleteAllForUser(USER)).toBe(1);
    expect(await repo.getMessages(USER, 'agent-2')).toEqual([]);
    expect(await repo.getMessages('user-2', AGENT)).toHaveLength(1);
  });
});
