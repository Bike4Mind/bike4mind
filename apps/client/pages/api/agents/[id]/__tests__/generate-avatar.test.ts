import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  agentFindById: vi.fn(),
  agentUpdate: vi.fn(),
  fabFileCreate: vi.fn(),
  storageUpload: vi.fn(),
  storageGetSignedUrl: vi.fn(),
  getOperationsModel: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  axiosGet: vi.fn(),
  moderateImageOrThrow: vi.fn(),
}));

// The route calls `baseApi().post(...)` directly, with no `.use(...)` in the chain.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));

vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: h.agentFindById, update: h.agentUpdate },
  imageModerationIncidentRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: {},
  fabFileRepository: { create: h.fabFileCreate },
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: h.getOperationsModel },
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));

vi.mock('axios', () => ({ default: { get: h.axiosGet } }));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: h.storageUpload, getSignedUrl: h.storageGetSignedUrl }),
}));

// Only the image-generation call and the settings read are stubbed; checkStorageLimit and
// the error classes stay real, so the quota gate under test is the real implementation.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSettingsMap: vi.fn(async () => ({})),
    aiImageService: vi.fn(() => ({ generate: vi.fn(async () => ['https://provider.test/avatar.png']) })),
  };
});

// Only moderateImageOrThrow is stubbed here - every other export of this barrel (image
// generation/edit, chat completion, etc.) stays real. This lets tests drive both a clean
// pass and an infrastructure failure directly, instead of only through the B4M_SELF_HOST
// bypass built into the real gate.
vi.mock('@bike4mind/services/llm', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    moderateImageOrThrow: h.moderateImageOrThrow,
  };
});

import handler from '../generate-avatar';
import { BadRequestError } from '@bike4mind/utils';

const AGENT = { id: 'agent-1', userId: 'u1', name: 'Test Agent' };

// The downloaded avatar is always exactly this many bytes in these tests, so the quota
// fixtures below can be sized to cross (or stay under) the limit on the image bytes alone.
const AVATAR_IMAGE_BYTES = 500_000;
const STORAGE_LIMIT_MB = 1; // checkStorageLimit converts this to a 1,000,000-byte limit

const makeReq = (user: Record<string, unknown>) =>
  ({
    method: 'POST',
    query: { id: 'agent-1' },
    body: {},
    user,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }) as never;

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { json, status } as never;
  return { res, json, status };
};

const run = (user: Record<string, unknown>, res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(makeReq(user), res);

describe('POST /api/agents/[id]/generate-avatar - storage quota', () => {
  const ORIGINAL_SELF_HOST = process.env.B4M_SELF_HOST;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.B4M_SELF_HOST = 'true';
    h.agentFindById.mockResolvedValue(AGENT);
    h.agentUpdate.mockResolvedValue(AGENT);
    h.fabFileCreate.mockResolvedValue({ id: 'file-1' });
    h.storageUpload.mockResolvedValue('avatar.png');
    h.storageGetSignedUrl.mockResolvedValue('https://s3.test/avatar.png');
    h.getOperationsModel.mockResolvedValue({
      modelId: 'text-model',
      llm: {
        complete: vi.fn(
          async (_model: unknown, _messages: unknown, _opts: unknown, onToken: (t: string[]) => unknown) =>
            onToken(['A vivid portrait prompt.'])
        ),
      },
      imageModelId: 'test-image-model',
      imageModelInfo: { backend: 'openai' },
    });
    h.getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-test' });
    h.axiosGet.mockResolvedValue({ data: Buffer.alloc(AVATAR_IMAGE_BYTES) });
    h.moderateImageOrThrow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.B4M_SELF_HOST = ORIGINAL_SELF_HOST;
  });

  it('refuses a user already over their storage quota, before uploading or creating a FabFile', async () => {
    const { res } = makeRes();
    // currentStorageSize alone (600,000) is well under the 1,000,000-byte limit; only
    // adding the 500,000-byte image pushes it over. A regression that stops forwarding
    // imageBuffer.length (e.g. checkStorageLimit(req.user!, 0)) would let this through.
    const overQuotaUser = { id: 'u1', isAdmin: false, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: 600_000 };

    const err = await run(overQuotaUser, res).catch(e => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toMatch(/storage limit/i);

    expect(h.storageUpload).not.toHaveBeenCalled();
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('allows a user within quota through to upload and FabFile creation', async () => {
    const { res } = makeRes();
    // Headroom before the image (501,000 bytes) is only just above the 500,000-byte
    // image, so this only passes if the real image size is forwarded and compared correctly.
    const withinQuotaUser = { id: 'u1', isAdmin: false, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: 499_000 };

    await run(withinQuotaUser, res);

    expect(h.storageUpload).toHaveBeenCalledTimes(1);
    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('surfaces a BadRequestError from image-model selection as a 400, without ever reaching the storage step', async () => {
    const { res } = makeRes();
    const anyUser = { id: 'u1', isAdmin: false, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: 0 };
    // No imageModel in the request body and no operations image model configured, so the
    // route throws "No image generation model available" well before download/moderation/storage.
    h.getOperationsModel.mockResolvedValue({
      modelId: 'text-model',
      llm: { complete: vi.fn(async () => undefined) },
      imageModelId: undefined,
      imageModelInfo: undefined,
    });

    const err = await run(anyUser, res).catch(e => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toMatch(/no image generation model available/i);

    expect(h.axiosGet).not.toHaveBeenCalled();
    expect(h.storageUpload).not.toHaveBeenCalled();
  });

  it('fails closed on a moderation-infrastructure error instead of returning the unmoderated provider URL', async () => {
    const { res, json, status } = makeRes();
    const withinQuotaUser = { id: 'u1', isAdmin: false, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: 0 };
    h.moderateImageOrThrow.mockRejectedValue(new Error('Rekognition request timed out'));

    await run(withinQuotaUser, res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).not.toHaveBeenCalledWith(expect.objectContaining({ portraitUrl: expect.anything() }));
    expect(h.storageUpload).not.toHaveBeenCalled();
    expect(h.fabFileCreate).not.toHaveBeenCalled();
    expect(h.agentUpdate).not.toHaveBeenCalled();
  });
});
