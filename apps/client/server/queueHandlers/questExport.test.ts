import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression guard for the shared-plan export image leak/loss: when a COLLABORATOR (in the plan's
 * `sharedWith`, not its owner) exports the plan, the per-image object-level access check must run
 * against the plan OWNER, not the caller. The owner's uploaded figures are not individually shared
 * with the collaborator, so authorizing them against the caller turned every figure into an "Image
 * unavailable" breadcrumb. This drives the REAL `dispatch`; only the process edges (DB, storage,
 * websocket, zip, LLM summary) are stubbed, and the access stub mimics the real ACL: a file is
 * accessible only to its owner.
 */

// Hoisted so the vi.mock factories (themselves hoisted above module init) can reference these.
const h = vi.hoisted(() => {
  const OWNER_ID = 'owner-1';
  const COLLABORATOR_ID = 'collab-2';
  const OWNER_FILE_ID = 'file-owner';
  const OWNER_IMAGE_URL = 'https://test-bucket.s3.amazonaws.com/uploads/owner-fig.png';
  const OWNER_IMAGE_KEY = 'uploads/owner-fig.png';
  return {
    OWNER_ID,
    COLLABORATOR_ID,
    OWNER_FILE_ID,
    OWNER_IMAGE_URL,
    OWNER_IMAGE_KEY,
    findAccessibleById: vi.fn(async (user: { id?: string } | null, fileId: string) =>
      user?.id === OWNER_ID ? { id: fileId } : null
    ),
    findUserById: vi.fn(async (id: string) => ({ id, _id: id })),
    planFindById: vi.fn(),
    questFind: vi.fn(() => ({
      lean: async () => [{ _id: 'q1', reply: `![fig](${OWNER_IMAGE_URL})`, images: [] }],
    })),
    fabFileFindOne: vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath === OWNER_IMAGE_KEY ? { id: OWNER_FILE_ID, filePath, moderationStatus: 'clean' } : null
    ),
    download: vi.fn(async () => Buffer.from('image-bytes')),
    createZipBuffer: vi.fn(async () => Buffer.from('zip')),
  };
});

// Run the raw handler directly (no SQS logger injection wrapper).
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};
vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: () => new Proxy({}, benignStub) }),
}));

vi.mock('@bike4mind/database', () => ({
  QuestMasterPlan: { findById: h.planFindById },
  Quest: { find: h.questFind },
  FabFile: { findOne: h.fabFileFindOne },
  fabFileRepository: { shareable: { findAccessibleById: h.findAccessibleById } },
  userRepository: { findById: h.findUserById },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));

vi.mock('@bike4mind/utils', () => ({
  secureParameters: <T>(obj: T) => obj,
  getSettingsByNames: vi.fn(),
}));

vi.mock('@bike4mind/common', () => ({
  ChatModels: { CLAUDE_4_5_HAIKU_BEDROCK: 'claude-haiku' },
  isImageServeable: (f: { moderationStatus?: string } | null) => f?.moderationStatus === 'clean',
}));

// No summary model available -> generateSummary short-circuits to null (no LLM call).
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn(async () => []),
  getLlmByModel: vi.fn(() => null),
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
}));

vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));

vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getMetadata = vi.fn().mockRejectedValue(new Error('not found')); // ZIP absent -> proceed
    upload = vi.fn().mockResolvedValue(undefined);
    getSignedUrl = vi.fn().mockResolvedValue('https://download.test/export.zip');
  },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: h.download }),
  getGeneratedImageStorage: () => ({ download: h.download }),
}));

vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));

vi.mock('@client/app/utils/subQuestStatusPresentation', () => ({ getSubQuestStatusIcon: () => '' }));

vi.mock('./createZipBuffer', () => ({ createZipBuffer: h.createZipBuffer }));

import { dispatch } from './questExport';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() });

const runExport = (callerId: string) => {
  h.planFindById.mockResolvedValue({
    userId: h.OWNER_ID,
    sharedWith: [h.COLLABORATOR_ID],
    goal: 'Shared Plan',
    state: 'active',
    quests: [
      {
        title: 'Q',
        description: 'd',
        complexity: 'simple',
        subQuests: [{ title: 'sq', status: 'completed', questId: 'q1' }],
      },
    ],
  });
  const event = {
    Records: [{ body: JSON.stringify({ exportJobId: 'job-1', planId: 'plan-1', userId: callerId }) }],
  };
  return dispatch(event as never, {} as never, makeLogger() as never);
};

describe('questExport image access subject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes owner-uploaded images against the plan owner, not the collaborator running the export', async () => {
    await runExport(h.COLLABORATOR_ID);

    // The access check ran against the OWNER (fix), so the owner-uploaded figure was retained...
    expect(h.findAccessibleById).toHaveBeenCalledWith(expect.objectContaining({ id: h.OWNER_ID }), h.OWNER_FILE_ID);
    expect(h.download).toHaveBeenCalledWith(h.OWNER_IMAGE_KEY);

    // ...and reached the zip instead of degrading to a breadcrumb.
    expect(h.createZipBuffer).toHaveBeenCalledTimes(1);
    const [markdown, imageBuffers] = h.createZipBuffer.mock.calls[0] as unknown as [string, unknown[]];
    expect(imageBuffers).toHaveLength(1);
    expect(markdown).not.toContain('Image unavailable');
  });
});
