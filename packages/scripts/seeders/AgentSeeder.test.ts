import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { AgentSeeder, type AgentSeed } from './AgentSeeder';
import { agentRepository, userRepository } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({
  agentRepository: {
    findByTriggerWords: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  userRepository: {
    findOne: vi.fn(),
  },
}));

const OWNER_ID = 'owner-1';

// A seed authored with an uppercase trigger word - the case the fix guards against.
const UPPERCASE_SEED: AgentSeed = {
  name: 'Coffee',
  triggerWord: '@Coffee',
  description: 'Test agent with an uppercase trigger word',
  systemPrompt: 'You are Coffee.',
  defaultThoroughness: 'quick',
  allowedTools: [],
};

const mockLogger = { info: vi.fn() } as unknown as Logger;

const mocked = {
  findByTriggerWords: vi.mocked(agentRepository.findByTriggerWords),
  create: vi.mocked(agentRepository.create),
  update: vi.mocked(agentRepository.update),
  findOne: vi.mocked(userRepository.findOne),
};

describe('AgentSeeder trigger-word normalization (#9436)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // any: the repository return type is a full IAgent document; the seeder only
    // reads `.id`, so a minimal stub keeps the test focused.
    mocked.findOne.mockResolvedValue({ id: OWNER_ID } as any);
    mocked.create.mockResolvedValue({ id: 'agent-1' } as any);
  });

  it('lowercases an uppercase trigger word at the lookup and write sites', async () => {
    mocked.findByTriggerWords.mockResolvedValue([]);

    await new AgentSeeder(mockLogger).seed([UPPERCASE_SEED]);

    // Lookup must use the lowercased form - `findByTriggerWords` is a case-sensitive
    // `$in`, and the model lowercases on save, so an uppercase lookup would miss.
    expect(mocked.findByTriggerWords).toHaveBeenCalledWith(['@coffee'], OWNER_ID);

    // The persisted document - both the top-level field and the embedded capabilities
    // JSON - must carry the lowercased trigger word.
    expect(mocked.create).toHaveBeenCalledTimes(1);
    const createArg = mocked.create.mock.calls[0][0] as {
      triggerWords: string[];
      capabilities: string[];
    };
    expect(createArg.triggerWords).toEqual(['@coffee']);
    expect(JSON.parse(createArg.capabilities[0]).triggerWords).toEqual(['@coffee']);
  });

  it('does not create a duplicate on re-seed of an uppercase seed', async () => {
    // Simulate the DB after a first seed run: the agent is stored lowercased (model
    // hook) and is only returned for a lowercase, case-sensitive `$in` lookup.
    mocked.findByTriggerWords.mockImplementation(async (triggerWords: string[]) =>
      // any: minimal stub - the seeder reads `.id`/`.userId` and the seeded fields.
      triggerWords.includes('@coffee')
        ? ([
            {
              id: 'agent-1',
              userId: OWNER_ID,
              name: UPPERCASE_SEED.name,
              description: UPPERCASE_SEED.description,
              triggerWords: ['@coffee'],
              systemPrompt: UPPERCASE_SEED.systemPrompt,
              defaultThoroughness: UPPERCASE_SEED.defaultThoroughness,
              allowedTools: [],
            },
          ] as any)
        : []
    );

    await new AgentSeeder(mockLogger).seed([UPPERCASE_SEED]);

    expect(mocked.findByTriggerWords).toHaveBeenCalledWith(['@coffee'], OWNER_ID);
    expect(mocked.create).not.toHaveBeenCalled();
  });
});
