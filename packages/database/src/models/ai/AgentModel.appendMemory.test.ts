import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Agent, agentRepository, MEMORY_JOURNAL_CONTENT_MAX_LENGTH } from './AgentModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Agent.deleteMany({}, { hardDelete: true });
});

const makeAgent = () =>
  Agent.create({
    name: 'Tavern Regular',
    description: 'desc',
    userId: 'user-me',
    triggerWords: ['@tavern'],
    capabilities: ['{}'],
    preferredModel: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 2048,
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
  });

const makeEntry = (content: string) => ({
  id: 'mem-1',
  timestamp: new Date(),
  source: 'conversation' as const,
  content,
  importance: 3,
});

describe('AgentRepository.appendMemory content cap', () => {
  it('truncates over-length content to the schema maxlength before storing it', async () => {
    const agent = await makeAgent();
    const overLength = 'a'.repeat(MEMORY_JOURNAL_CONTENT_MAX_LENGTH + 700);

    await agentRepository.appendMemory(agent.id, makeEntry(overLength));

    const stored = await Agent.findById(agent.id).lean();
    const content = stored?.memoryJournal?.[0]?.content;
    expect(content).toHaveLength(MEMORY_JOURNAL_CONTENT_MAX_LENGTH);
    expect(content).toBe(overLength.slice(0, MEMORY_JOURNAL_CONTENT_MAX_LENGTH));
  });

  it('keeps content at or under the cap unchanged', async () => {
    const agent = await makeAgent();
    const exact = 'b'.repeat(MEMORY_JOURNAL_CONTENT_MAX_LENGTH);

    await agentRepository.appendMemory(agent.id, makeEntry(exact));

    const stored = await Agent.findById(agent.id).lean();
    expect(stored?.memoryJournal?.[0]?.content).toBe(exact);
  });

  it('does not leave a lone high surrogate at the cut', async () => {
    const agent = await makeAgent();
    // Surrogate pair at code units 499-500 means the naive cut would end on a lone high surrogate.
    const content = 'c'.repeat(MEMORY_JOURNAL_CONTENT_MAX_LENGTH - 1) + '\uD83D\uDE00' + 'd'.repeat(10);

    await agentRepository.appendMemory(agent.id, makeEntry(content));

    const stored = await Agent.findById(agent.id).lean();
    const storedContent = stored?.memoryJournal?.[0]?.content ?? '';
    expect(storedContent.length).toBeLessThanOrEqual(MEMORY_JOURNAL_CONTENT_MAX_LENGTH);
    const lastUnit = storedContent.charCodeAt(storedContent.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
  });
});
