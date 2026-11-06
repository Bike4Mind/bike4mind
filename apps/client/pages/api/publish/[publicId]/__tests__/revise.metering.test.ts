// @vitest-environment node
/**
 * POST /api/publish/[publicId]/revise runs the operations model on the platform key, so it must hold
 * credits before the provider call and settle after. A credit refusal is a 422 that refunds the counted
 * publish action and frees the revise lock; a refusal must not keep the action the way a provider
 * failure after the hold does. The real meterPlatformCompletion + reserveRequestCredits
 * run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  record: vi.fn(async () => undefined),
  complete: vi.fn(),
}));

const p = vi.hoisted(() => ({
  refund: vi.fn(async () => undefined),
  updateOne: vi.fn(async () => ({})),
}));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/withRequestCompletionQuota', () => ({
  withRequestCompletionQuota: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (...hs: Array<(req: unknown, res: unknown) => unknown>) => hs[hs.length - 1] }),
}));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({
    download: async () => Buffer.from('<html><body>old page</body></html>'),
    upload: async () => undefined,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({ enqueuePublishThumbnail: vi.fn() }));
vi.mock('@server/services/publish', () => ({
  validateBundle: () => ({ valid: true }),
  buildPublishUrlPath: () => '/p/x',
  invalidatePublishCdn: vi.fn(),
  toCacheTarget: vi.fn(),
  checkInPlaceRewriteQuota: async () => ({ ok: true }),
  consumePublishAction: async () => ({ refund: p.refund }),
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'ops-model',
      modelInfo: {
        id: 'ops-model',
        name: 'Ops',
        backend: 'openai',
        pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
      },
      llm: { complete: m.complete },
    }),
  },
}));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  PublishedArtifact: {
    findOne: () => ({
      lean: async () => ({
        publicId: 'pub1',
        ownerId: 'u1',
        source: { kind: 'bundle' },
        sha256Index: 'sha-current',
        storageKeyPrefix: 'k/',
        manifest: [{ path: 'index.html', mimeType: 'text/html', size: 10, sha256: 'sha-current' }],
        size: { totalBytes: 10, fileCount: 1 },
        visibility: 'private',
        versions: [],
      }),
    }),
    findOneAndUpdate: async () => ({}),
    updateOne: p.updateOne,
  },
  Annotation: {
    find: () => ({ sort: () => ({ select: () => ({ lean: async () => [{ body: 'make it blue', anchor: {} }] }) }) }),
    updateMany: async () => ({}),
  },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  usageEventRepository: { record: m.record },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
}));
vi.mock('@bike4mind/services', async () => ({
  meterCompletionBackend: (await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services'))
    .meterCompletionBackend,
  creditService: { holdCredits: m.hold, releaseCreditHold: m.release, settleCreditHold: m.settleHold },
  organizationService: {},
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
  latchUsage: (u: Record<string, number>, info?: Record<string, number>) => {
    if (info?.inputTokens) u.inputTokens = info.inputTokens;
    if (info?.outputTokens) u.outputTokens = info.outputTokens;
  },
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  loadModelConfigurations: async () => [],
  createModelAdmission: () => ({ admits: async () => true, assert: async () => undefined }),
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: async () => [MODEL],
}));
const REVISED = '<html><body>' + 'new blue page '.repeat(5) + '</body></html>';

const { default: handler } = await import('@pages/api/publish/[publicId]/revise');

async function call() {
  const { req, res } = createMocks({ method: 'POST', query: { publicId: 'pub1' } });
  Object.assign(req, {
    user: { id: 'u1', tags: [], groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 1 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb([REVISED]);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/publish/[publicId]/revise metering', () => {
  it('holds before the provider call, settles once and keeps the counted publish action', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(p.refund).not.toHaveBeenCalled();
  });

  it('refunds the publish action, frees the lock and skips the provider on a credit refusal', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });

    expect(m.complete).not.toHaveBeenCalled();
    expect(p.refund).toHaveBeenCalledOnce();
    expect(p.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: { revisingAt: null } });
  });

  it('keeps the counted publish action when the provider fails after the hold', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    await expect(call()).rejects.toThrow('provider down');

    expect(m.release).toHaveBeenCalledOnce();
    expect(p.refund).not.toHaveBeenCalled();
  });
});
