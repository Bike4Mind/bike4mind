// @vitest-environment node
/**
 * Scope enforcement for /api/v1/transcriptions through the REAL baseApi chain (apiKeyAuth included):
 * both routes accept ai:generate only, and a rejected key never reaches the transcribe helpers.
 * Same harness shape as pages/api/v1/files/__tests__/scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindUser, mockRateLimit, mockCreateUpload, mockTranscribe } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCreateUpload: vi.fn(),
  mockTranscribe: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
// The real module builds an S3 client and reads SST resources at import, so it is replaced whole.
vi.mock('@server/transcribe/transcribe', async () => {
  const { BadRequestError } = await import('@server/utils/errors');
  class TranscribeRequestError extends BadRequestError {
    constructor(
      public kind: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    TranscribeRequestError,
    PRESIGNED_POST_EXPIRY_SECONDS: 300,
    createTranscribeUpload: (...a: unknown[]) => mockCreateUpload(...a),
    transcribeUpload: (...a: unknown[]) => mockTranscribe(...a),
  };
});

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope } from '@bike4mind/common';
import uploads from '../uploads';
import transcriptions from '../index';

const KEY = 'transcribe-uploads/user-1/abc.mp3';

function withScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

// any: the handlers' Express-typed params vs node-mocks-http mocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(handler: any, url: string, body: object) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url,
      body,
      headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return res;
}

const upload = (body: object = { mime_type: 'audio/mpeg', file_size: 1000 }) =>
  fire(uploads, '/api/v1/transcriptions/uploads', body);
const transcribe = (body: object = { file_key: KEY }) => fire(transcriptions, '/api/v1/transcriptions', body);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockCreateUpload.mockResolvedValue({ url: 'https://bucket.example/', fields: { key: KEY }, fileKey: KEY });
  mockTranscribe.mockResolvedValue({ text: 'hello' });
});

describe('/api/v1/transcriptions scope enforcement (real middleware chain)', () => {
  it('an ai:generate key can mint an upload (201) and transcribe (200)', async () => {
    withScopes([ApiKeyScope.AI_GENERATE]);
    expect((await upload())._getStatusCode()).toBe(201);
    const res = await transcribe();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ text: 'hello' });
  });

  it('a key without ai:generate is refused (403) and nothing is minted or transcribed', async () => {
    withScopes([ApiKeyScope.AI_CHAT, ApiKeyScope.WRITE_FILES]);
    for (const res of [await upload(), await transcribe()]) {
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.AI_GENERATE]);
    }
    expect(mockCreateUpload).not.toHaveBeenCalled();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('an invalid key is refused (401)', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    expect((await upload())._getStatusCode()).toBe(401);
    expect((await transcribe())._getStatusCode()).toBe(401);
  });

  it('an unknown body field is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.AI_GENERATE]);
    expect((await transcribe({ fileKey: KEY }))._getStatusCode()).toBe(422);
    expect((await upload({ mime_type: 'audio/mpeg', file_size: 1000, name: 'x' }))._getStatusCode()).toBe(422);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('serves the insufficient-credits classifier through the real error handler', async () => {
    withScopes([ApiKeyScope.AI_GENERATE]);
    const { TranscribeRequestError } = (await import('@server/transcribe/transcribe')) as unknown as {
      TranscribeRequestError: new (kind: string, message: string) => Error;
    };
    mockTranscribe.mockRejectedValue(new TranscribeRequestError('insufficient_credits', 'No credits'));

    const res = await transcribe();

    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ error: 'No credits', errorCode: 'insufficient_credits' });
  });
});
