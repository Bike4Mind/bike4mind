import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findSession: vi.fn(),
  getOperationsModel: vi.fn(),
  autoName: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: { AutoName: { schema: { parse: (properties: unknown) => properties } } },
}));
vi.mock('@bike4mind/database', () => ({
  Session: { findById: mocks.findSession },
  userRepository: { findById: mocks.findUser },
  sessionRepository: {},
  questRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ sessionService: { autoName: mocks.autoName } }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mocks.getOperationsModel },
}));
vi.mock('@workers/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: mocks.recordUsage }));

import { handler } from './sessionAutoNaming';

const logger = { info: vi.fn(), warn: vi.fn(), updateMetadata: vi.fn() };
const run = (userId?: string) =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { properties: { sessionId: 'session-1', userId } },
    logger
  );

describe('session auto-naming AI access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findSession.mockResolvedValue({ id: 'session-1', userId: 'owner-1', name: 'Untitled' });
    mocks.findUser.mockResolvedValue({ id: 'owner-1' });
    mocks.getOperationsModel.mockResolvedValue({ modelId: 'test-model', llm: {}, modelInfo: {} });
    mocks.autoName.mockResolvedValue({ name: 'Generated name' });
  });

  it.each([null, { id: 'owner-1', riskScore: { reviewState: 'pending' } }, { id: 'owner-1', isModerated: true }])(
    'skips queued naming before resolving a model when the user cannot use AI: %j',
    async user => {
      mocks.findUser.mockResolvedValue(user);
      await run();
      expect(mocks.findUser).toHaveBeenCalledWith('owner-1');
      expect(mocks.getOperationsModel).not.toHaveBeenCalled();
      expect(mocks.autoName).not.toHaveBeenCalled();
      expect(mocks.recordUsage).not.toHaveBeenCalled();
    }
  );

  it('uses the event actor when specified and resumes work after approval', async () => {
    mocks.findUser.mockResolvedValue({ id: 'actor-1', riskScore: { reviewState: 'approved' } });
    await run('actor-1');
    expect(mocks.findUser).toHaveBeenCalledWith('actor-1');
    expect(mocks.autoName).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'actor-1' }));
  });

  it('runs no model when the account lookup fails', async () => {
    mocks.findUser.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(run()).rejects.toThrow('database unavailable');
    expect(mocks.getOperationsModel).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});
