import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessContext } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  listDataLakes: vi.fn(),
  isFallbackLake: vi.fn(),
  isFeatureEnabled: vi.fn(),
  findTexts: vi.fn(),
  checkCredits: vi.fn(),
  recordUsage: vi.fn(),
  getOperationsModel: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@server/dataLakes/lakeMembershipWrite', () => ({ lakeAccessDb: {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { listDataLakes: mocks.listDataLakes, isFallbackLake: mocks.isFallbackLake },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  fabFileChunkRepository: { findTextsByFabFileId: mocks.findTexts },
  fabFileRepository: {},
  obligationDayToDate: vi.fn(),
  obligationRepository: {},
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ isFeatureEnabled: mocks.isFeatureEnabled }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mocks.getOperationsModel },
}));
vi.mock('@bike4mind/server-utils/billing/recordSessionOperationalUsage', () => ({
  recordSessionOperationalUsage: mocks.recordUsage,
}));
vi.mock('@bike4mind/server-utils/utils/sessionOperationalCreditPreflight', () => ({
  checkSessionOperationalCredits: mocks.checkCredits,
}));

import { createHandOffDeps } from './handOffDocument';

const ctx = {} as AccessContext;
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('createHandOffDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isFeatureEnabled.mockResolvedValue(true);
    mocks.isFallbackLake.mockImplementation((lake: { id: string }) => lake.id === 'builtin');
    mocks.listDataLakes.mockResolvedValue([
      { id: 'mine', name: 'Bills', canManage: true },
      { id: 'viewer', name: 'Shared', canManage: false },
      { id: 'builtin', name: 'Default', canManage: true },
    ]);
  });

  it('offers only manageable, non-built-in lakes', async () => {
    const deps = createHandOffDeps(ctx, logger, { offerLakes: true });
    expect(await deps.listLakes()).toEqual([{ id: 'mine', name: 'Bills' }]);
  });

  it('offers no lakes when the caller may not file into them or data lakes are off', async () => {
    expect(await createHandOffDeps(ctx, logger, { offerLakes: false }).listLakes()).toEqual([]);
    mocks.isFeatureEnabled.mockResolvedValue(false);
    expect(await createHandOffDeps(ctx, logger, { offerLakes: true }).listLakes()).toEqual([]);
    expect(mocks.listDataLakes).not.toHaveBeenCalled();
  });

  it('joins file chunks with newlines', async () => {
    mocks.findTexts.mockResolvedValue([{ text: 'one' }, { text: 'two' }]);
    const deps = createHandOffDeps(ctx, logger, { offerLakes: false });
    expect(await deps.fileText('file-1')).toBe('one\ntwo');
  });

  it('funds from the operational credit preflight', async () => {
    const deps = createHandOffDeps(ctx, logger, { offerLakes: false });
    mocks.checkCredits.mockResolvedValue({ allowed: false });
    expect(await deps.canFund('user-1')).toBe(false);
    mocks.checkCredits.mockResolvedValue({ allowed: true });
    expect(await deps.canFund('user-1')).toBe(true);
    expect(mocks.checkCredits).toHaveBeenCalledWith({
      userId: 'user-1',
      operationCount: 1,
      operation: 'scanned document',
      logger,
    });
  });

  it('rethrows a daily cap or spend freeze instead of reporting no credits', async () => {
    const deps = createHandOffDeps(ctx, logger, { offerLakes: false });
    const dailyCapError = Object.assign(new Error('daily cap'), { statusCode: 429 });
    mocks.checkCredits.mockResolvedValue({ allowed: false, reason: 'cap', dailyCapError });
    await expect(deps.canFund('user-1')).rejects.toBe(dailyCapError);
    const frozenError = Object.assign(new Error('frozen'), { statusCode: 403 });
    mocks.checkCredits.mockResolvedValue({ allowed: false, reason: 'frozen', frozenError });
    await expect(deps.canFund('user-1')).rejects.toBe(frozenError);
  });

  it('joins the streamed reply and charges the obligation id as a document_obligation', async () => {
    const modelInfo = { id: 'm' };
    const info = { inputTokens: 1 };
    mocks.getOperationsModel.mockResolvedValue({
      modelId: 'ops-model',
      modelInfo,
      llm: {
        complete: async (
          _m: string,
          _msgs: unknown,
          _o: unknown,
          cb: (c: (string | null)[], i?: unknown) => Promise<void>
        ) => {
          await cb(['{"a":', null], undefined);
          await cb(['1}'], info);
        },
      },
    });
    const deps = createHandOffDeps(ctx, logger, { offerLakes: false });
    const store = vi.fn(async (_reply: string, _model: string) => {
      expect(mocks.recordUsage).not.toHaveBeenCalled();
      return { sessionId: 'obligation-1', value: 'stored' };
    });
    await expect(deps.complete('user-1', 'prompt', store)).resolves.toBe('stored');
    expect(store).toHaveBeenCalledWith('{"a":1}', 'ops-model');

    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: 'obligation-1',
        operation: 'document_obligation',
        modelId: 'ops-model',
        modelInfo,
        completionInfo: info,
        logger,
      })
    );
  });

  it('does not charge when the store throws', async () => {
    mocks.getOperationsModel.mockResolvedValue({
      modelId: 'ops-model',
      modelInfo: { id: 'm' },
      llm: { complete: async () => {} },
    });
    const deps = createHandOffDeps(ctx, logger, { offerLakes: false });
    await expect(deps.complete('user-1', 'prompt', async () => Promise.reject(new Error('db down')))).rejects.toThrow(
      'db down'
    );
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});
