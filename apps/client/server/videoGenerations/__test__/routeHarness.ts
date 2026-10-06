/**
 * Test-only harness shared by the video route integration tests in pages/api/v1/__tests__. It imports vitest, so
 * app code must never import it. vi.mock calls cannot live here (vitest hoists them per test file): each test
 * file keeps its own vi.mock lines and points every factory at the builders below.
 */
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { vi } from 'vitest';
import { CreditHolderType, type IGenerationJobDocument } from '@bike4mind/common';

type ImportOriginal = <T>() => Promise<T>;
type ModuleExports = Record<string, unknown>;

export const h = {
  validate: vi.fn(),
  userFindById: vi.fn(),
  rateLimit: vi.fn(),
  createVideoJob: vi.fn(),
  listByRequester: vi.fn(),
  findById: vi.fn(),
  requestCancel: vi.fn(),
  sign: vi.fn(),
  listUsableVideoModels: vi.fn(),
  hasUsableKey: vi.fn(),
  providersGet: vi.fn(),
};

export const VALID_KEY = 'sk-test-valid-key';
export const JOB_ID = '6'.repeat(24); // a valid ObjectId string without a pasted-id literal (check-no-account-ids)

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};
const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', organizationId: null, isBanned: false, disputePending: false };

// vi.mock factories (one per mocked module), called from each test file's own vi.mock lines.
export const apiKeyRateLimitCheckMock = async (orig: ImportOriginal) => ({
  ...(await orig<ModuleExports>()),
  checkApiKeyRateLimit: (...a: unknown[]) => h.rateLimit(...a),
});

// perUserRateLimit would otherwise count in Mongo (cacheRepository), which these tests do not connect to.
export const rateLimitMiddlewareMock = () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
});

export const userRateTierMock = () => ({ resolveUserRateLimitPerMin: () => 60 });

export const servicesMock = async (orig: ImportOriginal) => {
  const actual = await orig<ModuleExports>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => h.validate(...a),
    },
  };
};

export const videoJobsServiceMock = async (orig: ImportOriginal) => ({
  ...(await orig<ModuleExports>()),
  createVideoJob: (...a: unknown[]) => h.createVideoJob(...a),
});

export const databaseMock = async (orig: ImportOriginal) => {
  const actual = await orig<ModuleExports>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => h.userFindById(...a) }),
    generationJobRepository: {
      listByRequester: (...a: unknown[]) => h.listByRequester(...a),
      findById: (...a: unknown[]) => h.findById(...a),
    },
  };
};

export const wiringMock = () => ({
  getCreateVideoJobDeps: () => ({ providers: { get: (...a: unknown[]) => h.providersGet(...a) } }),
  getVideoJobDeps: () => ({}),
  getGenerationJobEngine: () => ({ requestCancel: (...a: unknown[]) => h.requestCancel(...a) }),
});

export const signOutputUrlMock = () => ({ signOutputUrl: (...a: unknown[]) => h.sign(...a) });

export const listUsableVideoModelsMock = async (orig: ImportOriginal) => ({
  ...(await orig<ModuleExports>()),
  listUsableVideoModels: (...a: unknown[]) => h.listUsableVideoModels(...a),
  hasUsableKey: (...a: unknown[]) => h.hasUsableKey(...a),
});

export const authMock = async (orig: ImportOriginal) => ({
  ...(await orig<ModuleExports>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (req: any, _res: any, next: any) => {
    if (!req.user) req.user = JWT_USER;
    next();
  },
});

export const fire = ({
  method = 'GET',
  url,
  apiKey = VALID_KEY as string | null,
  body,
  query,
  headers = {},
}: {
  method?: 'GET' | 'POST';
  url: string;
  apiKey?: string | null;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}) => {
  const { req, res } = createMocks(
    { method, url, body, query, headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}), ...headers } },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
};

export const validateWithScopes = (scopes: string[], userId = 'user-1') =>
  h.validate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId,
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });

export const asUser = (id: string, organizationId: string | null = null) =>
  h.userFindById.mockResolvedValue({ id, _id: id, organizationId, isBanned: false, disputePending: false });

export const videoJob = (overrides: Partial<IGenerationJobDocument> = {}): IGenerationJobDocument =>
  ({
    id: JOB_ID,
    kind: 'video',
    ownerType: CreditHolderType.User,
    ownerId: 'user-1',
    requestedBy: 'user-1',
    source: 'api',
    state: 'pending',
    payload: {
      request: {
        model: 'gemini-omni-1.1-flash',
        mode: 'text_to_video',
        prompt: 'a lighthouse',
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '720p',
      },
      providerId: 'gemini-omni',
    },
    pollCount: 0,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-06T00:20:00Z'),
    creditHold: null,
    createdAt: new Date('2026-10-06T00:00:00Z'),
    updatedAt: new Date('2026-10-06T00:00:00Z'),
    ...overrides,
  }) as IGenerationJobDocument;

export const resetHarness = () => {
  vi.clearAllMocks();
  asUser('user-1');
  h.rateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
  h.providersGet.mockReturnValue({ id: 'gemini-omni' });
  h.hasUsableKey.mockResolvedValue(true);
  h.sign.mockImplementation(async (_location: string, key: string) => `https://signed.example/${key}`);
};
