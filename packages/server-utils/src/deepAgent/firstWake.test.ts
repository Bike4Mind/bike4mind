import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { AI_ACCESS_REVOKED_MESSAGE } from '@bike4mind/services/userService/accountState';

const mocks = vi.hoisted(() => ({
  owner: {} as Record<string, unknown>,
  resolveBackend: vi.fn(),
  meter: vi.fn(),
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  userRepository: { findById: async () => mocks.owner },
}));
vi.mock('./contributedToolbelts', () => ({}));
vi.mock('./store', () => ({
  MongoDeepAgentStore: class {
    loadCharter = async () => ({ identity: { ownerUserId: 'owner-1' } });
  },
}));
vi.mock('./llmSteps', () => ({ LlmWakeSteps: class {} }));
vi.mock('./toolMaterializer', () => ({ createDeepAgentToolMaterializer: vi.fn() }));
vi.mock('./missions', () => ({ loadLinkedAgentContext: vi.fn() }));
vi.mock('./missionSessionBridge', () => ({ bridgeWakeToSession: vi.fn() }));
vi.mock('../utils/thinkingVisibility', () => ({ resolveThinkingVisibilityForUserId: vi.fn() }));
vi.mock('./resolveBackend', () => ({
  DEFAULT_WAKE_MODEL_ID: 'wake-model',
  resolveDeepAgentBackend: mocks.resolveBackend,
}));
vi.mock('./wakeMetering', async importOriginal => ({
  ...(await importOriginal<typeof import('./wakeMetering')>()),
  missionWakeMeter: mocks.meter,
}));

import { runMissionFirstWake } from './firstWake';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveBackend.mockResolvedValue(null);
});

describe('runMissionFirstWake account standing', () => {
  it('refuses a restricted owner with a 403 before metering or building a backend', async () => {
    mocks.owner = { id: 'owner-1', isModerated: true };

    await expect(runMissionFirstWake('mission-1', { logger: new Logger() })).rejects.toMatchObject({
      statusCode: 403,
      message: AI_ACCESS_REVOKED_MESSAGE,
    });
    expect(mocks.meter).not.toHaveBeenCalled();
    expect(mocks.resolveBackend).not.toHaveBeenCalled();
  });

  it('proceeds to the backend for a healthy owner', async () => {
    mocks.owner = { id: 'owner-1' };

    await expect(runMissionFirstWake('mission-1', { logger: new Logger() })).rejects.toThrow(
      'could not resolve wake model'
    );
    expect(mocks.meter).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBackend).toHaveBeenCalledTimes(1);
  });
});
