import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  findById: vi.fn(),
  claimModelInconsistencyRun: vi.fn(),
  releaseModelInconsistencyRun: vi.fn(),
  detectLakeInconsistenciesModel: vi.fn(),
  recordLakeFindings: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  listGrantsByLake: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@server/queueHandlers/utils', () => ({
  // Pass-through so the handler's own logic is what the tests exercise, with a logger it can call.
  dispatchWithLogger:
    (fn: (event: unknown, context: unknown, logger: unknown) => Promise<void>) => (event: unknown, context: unknown) =>
      fn(event, context, {
        updateMetadata: vi.fn(),
        info: h.loggerInfo,
        warn: h.loggerWarn,
        error: h.loggerError,
      }),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    detectLakeInconsistenciesModel: h.detectLakeInconsistenciesModel,
    recordLakeFindings: h.recordLakeFindings,
    MODEL_INCONSISTENCY_DETECTOR: 'model',
    // The real resolver, not a stub: the point of the owner tests below is that this handler routes
    // spend through the same owner rule as the rest of the lake surface, so stubbing it would assert
    // only that the handler calls something.
    resolveEffectiveOwnerIds: (
      lakeDoc: { createdByUserId: string },
      grants: { principalType: string; principalId: string; role: string }[] = []
    ) => {
      const owners = grants.filter(g => g.principalType === 'user' && g.role === 'owner').map(g => g.principalId);
      return owners.length > 0 ? owners : [lakeDoc.createdByUserId];
    },
  },
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  apiKeyRepository: {},
  dataLakeAccessGrantRepository: { listByLake: h.listGrantsByLake },
  dataLakeFindingRepository: {},
  dataLakeRepository: {
    findById: h.findById,
    claimModelInconsistencyRun: h.claimModelInconsistencyRun,
    releaseModelInconsistencyRun: h.releaseModelInconsistencyRun,
  },
  fabFileChunkRepository: {},
  fabFileRepository: {},
}));

import { dispatch } from './lakeInconsistencyModelDetection';

const lake = { id: 'lakeDoc1', datalakeTag: 'datalake:acme', createdByUserId: 'owner1' };

const emptyResult = {
  findings: [],
  memberCount: 0,
  memberSampled: false,
  batchesRun: 0,
  batchesFailed: 0,
  batchesUnpersisted: 0,
  subjectsDropped: 0,
  dismissedSuppressed: 0,
  subjectsMerged: 0,
  deadlineReached: false,
  truncated: false,
};

const invoke = (body: Record<string, unknown> = { dataLakeId: 'lake1', userId: 'u1' }, remainingMs = 600_000) =>
  (dispatch as unknown as (event: unknown, context: unknown) => Promise<void>)(
    { Records: [{ body: JSON.stringify(body) }] },
    { getRemainingTimeInMillis: () => remainingMs }
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingsValue.mockResolvedValue(true);
  h.findById.mockResolvedValue(lake);
  h.claimModelInconsistencyRun.mockResolvedValue(true);
  h.releaseModelInconsistencyRun.mockResolvedValue(undefined);
  h.detectLakeInconsistenciesModel.mockResolvedValue(emptyResult);
  h.recordLakeFindings.mockResolvedValue({ recorded: 0, failed: 0 });
  h.getEffectiveLLMApiKeys.mockResolvedValue({});
  h.listGrantsByLake.mockResolvedValue([]);
});

describe('lakeInconsistencyModelDetection queue handler (#3057)', () => {
  it('runs the detector for the queued lake', async () => {
    await invoke();

    expect(h.detectLakeInconsistenciesModel).toHaveBeenCalledTimes(1);
    expect(h.detectLakeInconsistenciesModel.mock.calls[0][0]).toBe(lake);
  });

  it('bills the effective owner, not the creator, when the lake has been transferred', async () => {
    // A transferred lake still carries its original createdByUserId. Charging that is charging the
    // person it was transferred away from - resolveEffectiveOwnerIds is the rule the rest of the lake
    // surface already uses to answer who pays, and `endUserId` must carry the same id to the provider.
    h.listGrantsByLake.mockResolvedValue([{ principalType: 'user', principalId: 'newOwner', role: 'owner' }]);

    await invoke();

    expect(h.getEffectiveLLMApiKeys).toHaveBeenCalledWith('newOwner', expect.anything(), expect.anything());
    expect(h.detectLakeInconsistenciesModel.mock.calls[0][1].endUserId).toBe('newOwner');
  });

  it('bills the creator when the lake carries no owner grant', async () => {
    await invoke();

    expect(h.getEffectiveLLMApiKeys).toHaveBeenCalledWith('owner1', expect.anything(), expect.anything());
    expect(h.detectLakeInconsistenciesModel.mock.calls[0][1].endUserId).toBe('owner1');
  });

  it('falls back to the creator rather than stranding a claimed lease when the grant read fails', async () => {
    // The lease is already held by this point, so throwing here would cost the lake its whole lease
    // window for a lookup whose own fallback is the creator anyway.
    h.listGrantsByLake.mockRejectedValue(new Error('mongo blip'));

    await invoke();

    expect(h.getEffectiveLLMApiKeys).toHaveBeenCalledWith('owner1', expect.anything(), expect.anything());
    expect(h.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('could not read lake grants'), expect.anything());
  });

  it('re-checks the kill-switch at consume time, not just at enqueue time', async () => {
    // A message can sit in the queue for the full visibility window and across retries, so a flag
    // flipped after the enqueue must still stop the spend.
    h.getSettingsValue.mockResolvedValue(false);

    await invoke();

    expect(h.detectLakeInconsistenciesModel).not.toHaveBeenCalled();
    expect(h.claimModelInconsistencyRun).not.toHaveBeenCalled();
  });

  it('lets a failed flag lookup throw so SQS retries, rather than dropping real work', async () => {
    // A rejected lookup is "we could not tell", not a resolved false - collapsing the two would
    // discard the run with no retry and no DLQ over a transient Mongo blip.
    h.getSettingsValue.mockRejectedValue(new Error('mongo unavailable'));

    await expect(invoke()).rejects.toThrow('mongo unavailable');
    expect(h.detectLakeInconsistenciesModel).not.toHaveBeenCalled();
  });

  it('drops the message when the lake no longer exists', async () => {
    h.findById.mockResolvedValue(null);

    await invoke();

    expect(h.detectLakeInconsistenciesModel).not.toHaveBeenCalled();
    expect(h.claimModelInconsistencyRun).not.toHaveBeenCalled();
  });

  it('does not run when another run already holds the lease', async () => {
    // The route's isLeaseHeld precondition cannot exclude a concurrent run - two requests can both
    // read "no lease" before either enqueues - so this guarded claim is the real mutual exclusion.
    h.claimModelInconsistencyRun.mockResolvedValue(false);

    await invoke();

    expect(h.detectLakeInconsistenciesModel).not.toHaveBeenCalled();
  });

  it('releases the lease it claimed, with the same stamp it claimed', async () => {
    await invoke();

    const claimedAt = h.claimModelInconsistencyRun.mock.calls[0][1];
    expect(h.releaseModelInconsistencyRun).toHaveBeenCalledWith(lake.id, claimedAt);
  });

  it('releases the lease even when the run throws, so a failure cannot wedge the lake', async () => {
    h.detectLakeInconsistenciesModel.mockRejectedValue(new Error('llm exploded'));

    await expect(invoke()).rejects.toThrow('llm exploded');
    expect(h.releaseModelInconsistencyRun).toHaveBeenCalledTimes(1);
  });

  it('resolves the LAKE OWNER api keys, not the enqueuing caller', async () => {
    await invoke({ dataLakeId: 'lake1', userId: 'someoneElse' });

    expect(h.getEffectiveLLMApiKeys.mock.calls[0][0]).toBe('owner1');
    expect(h.detectLakeInconsistenciesModel.mock.calls[0][1].endUserId).toBe('owner1');
  });

  it('persists each batch as it lands, under detector "model"', async () => {
    const findings = [{ kind: 'narrative-contradiction', subject: 'refund window', evidence: [], documentCount: 2 }];
    h.detectLakeInconsistenciesModel.mockImplementation(async (_lake, adapters) => {
      await adapters.onBatchFindings(findings);
      return { ...emptyResult, findings, batchesRun: 1 };
    });

    await invoke();

    expect(h.recordLakeFindings).toHaveBeenCalledTimes(1);
    const [lakeId, passed, options] = h.recordLakeFindings.mock.calls[0];
    expect(lakeId).toBe('lakeDoc1');
    expect(passed).toBe(findings);
    expect(options.detector).toBe('model');
  });

  it('stamps every batch of one run with the same seenAt rather than drifting by write latency', async () => {
    h.detectLakeInconsistenciesModel.mockImplementation(async (_lake, adapters) => {
      await adapters.onBatchFindings([
        { kind: 'narrative-contradiction', subject: 'a', evidence: [], documentCount: 2 },
      ]);
      await adapters.onBatchFindings([
        { kind: 'narrative-contradiction', subject: 'b', evidence: [], documentCount: 2 },
      ]);
      return { ...emptyResult, batchesRun: 2 };
    });

    await invoke();

    expect(h.recordLakeFindings).toHaveBeenCalledTimes(2);
    expect(h.recordLakeFindings.mock.calls[0][2].seenAt).toEqual(h.recordLakeFindings.mock.calls[1][2].seenAt);
  });

  it('passes the real Lambda clock so the run stops before it is killed mid-call', async () => {
    await invoke({ dataLakeId: 'lake1', userId: 'u1' }, 12_345);

    expect(h.detectLakeInconsistenciesModel.mock.calls[0][1].getRemainingTimeInMillis()).toBe(12_345);
  });

  it('degrades to no deadline when the context has no clock, rather than throwing mid-run', async () => {
    await (dispatch as unknown as (event: unknown, context: unknown) => Promise<void>)(
      { Records: [{ body: JSON.stringify({ dataLakeId: 'lake1', userId: 'u1' }) }] },
      {}
    );

    expect(h.detectLakeInconsistenciesModel.mock.calls[0][1].getRemainingTimeInMillis()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('swallows a malformed payload rather than retrying something retry cannot fix', async () => {
    await (dispatch as unknown as (event: unknown, context: unknown) => Promise<void>)(
      { Records: [{ body: JSON.stringify({ userId: 'u1' }) }] },
      {}
    );

    expect(h.detectLakeInconsistenciesModel).not.toHaveBeenCalled();
    expect(h.loggerWarn).toHaveBeenCalled();
  });

  it('rethrows an infrastructure failure so SQS retries and then DLQs it', async () => {
    h.findById.mockRejectedValue(new Error('mongo timeout'));

    await expect(invoke()).rejects.toThrow('mongo timeout');
  });
});
