// @vitest-environment node
/**
 * The four authoring assistants (generate-avatar, generate-description, generate-system-prompt,
 * enhance-field) through the REAL baseApi chain: each needs agents:write, answers a sharee with the
 * same 404 as a stranger, maps its core's result onto the snake_case wire, and reports a provider
 * failure as a 502 instead of the SPA route's 500 body. The cores are stubbed; their behavior is
 * covered through the legacy routes. Same harness shape as ../../__tests__/scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockRateLimit,
  mockFindById,
  mockAvatar,
  mockDescription,
  mockSystemPrompt,
  mockEnhance,
  rateLimitBuckets,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockFindById: vi.fn(),
  mockAvatar: vi.fn(),
  mockDescription: vi.fn(),
  mockSystemPrompt: vi.fn(),
  mockEnhance: vi.fn(),
  rateLimitBuckets: [] as string[],
}));

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: { bucket: string }) => {
    rateLimitBuckets.push(options.bucket);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

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
    withTransaction: (fn: () => Promise<unknown>) => fn(),
    User: Object.assign(Object.create(RealUser), {
      findById: (...a: unknown[]) => mockFindUser(...a),
      updateMany: vi.fn().mockResolvedValue(undefined),
    }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
    agentRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@server/agents/authoring/generateAgentAvatar', () => ({
  generateAgentAvatar: (...a: unknown[]) => mockAvatar(...a),
}));
vi.mock('@server/agents/authoring/generateAgentDescription', () => ({
  generateAgentDescription: (...a: unknown[]) => mockDescription(...a),
}));
vi.mock('@server/agents/authoring/generateAgentSystemPrompt', () => ({
  generateAgentSystemPrompt: (...a: unknown[]) => mockSystemPrompt(...a),
}));
vi.mock('@server/agents/authoring/enhanceAgentField', () => ({
  enhanceAgentField: (...a: unknown[]) => mockEnhance(...a),
}));

import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { SystemPromptRateLimitError } from '@server/agents/systemPromptRateLimit';
import generateAvatar from '../generate-avatar';
import generateDescription from '../generate-description';
import generateSystemPrompt from '../generate-system-prompt';
import enhanceField from '../enhance-field';

const AGENT_ID = '65a000000000000000000001';
const AGENT = { id: AGENT_ID, name: 'Researcher', userId: 'user-1' };

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
async function fire(handler: any, action: string, body: object = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: `/api/v1/agents/${AGENT_ID}/${action}`,
      query: { id: AGENT_ID },
      body,
      headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return res;
}

const ENHANCE_BODY = { field_name: 'quirk', current_value: 'Hums while thinking' };

const ROUTES = [
  { name: 'generate-avatar', handler: generateAvatar, core: mockAvatar, body: {} },
  { name: 'generate-description', handler: generateDescription, core: mockDescription, body: {} },
  { name: 'generate-system-prompt', handler: generateSystemPrompt, core: mockSystemPrompt, body: {} },
  { name: 'enhance-field', handler: enhanceField, core: mockEnhance, body: ENHANCE_BODY },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    level: 'PaidUser',
    isBanned: false,
    disputePending: false,
  });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockFindById.mockResolvedValue(AGENT);
  mockAvatar.mockResolvedValue({ portraitUrl: 'https://s3.test/a.png', generationPrompt: 'a portrait' });
  mockDescription.mockResolvedValue('A curious researcher.');
  mockSystemPrompt.mockResolvedValue('You are a researcher.');
  mockEnhance.mockResolvedValue('Hums Bach while thinking.');
});

describe.each(ROUTES)('POST /api/v1/agents/{id}/$name', ({ name, handler, core, body }) => {
  it('a read-only key is refused (403) before the agent is loaded or the model runs', async () => {
    withScopes([ApiKeyScope.READ_AGENTS]);
    const res = await fire(handler, name, body);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_AGENTS]);
    expect(mockFindById).not.toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
  });

  it('an invalid key is a 401 and nothing runs', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    const res = await fire(handler, name, body);
    expect(res._getStatusCode()).toBe(401);
    expect(core).not.toHaveBeenCalled();
  });

  it('a sharee gets the same 404 as a stranger and the model never runs', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockFindById.mockResolvedValue({ ...AGENT, userId: 'someone-else' });
    const res = await fire(handler, name, body);
    expect(res._getStatusCode()).toBe(404);
    expect(core).not.toHaveBeenCalled();
  });

  it('a provider failure is a 502 whose message carries no upstream text', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    core.mockRejectedValue(new Error('sk-secret upstream exploded'));
    const res = await fire(handler, name, body);
    expect(res._getStatusCode()).toBe(502);
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk-secret');
  });

  it('a typed error from the core keeps its own status', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    core.mockRejectedValue(new BadRequestError('The assistant is disabled'));
    const res = await fire(handler, name, body);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe('The assistant is disabled');
  });
});

describe('authoring assistants - shared limits', () => {
  it('all four routes draw on one per-user rate limit bucket', () => {
    expect(rateLimitBuckets).toHaveLength(4);
    expect(new Set(rateLimitBuckets).size).toBe(1);
  });

  it.each([
    ['field_name over 100 characters', { field_name: 'q'.repeat(101), current_value: 'x' }],
    ['current_value over 2000 characters', { field_name: 'quirk', current_value: 'x'.repeat(2001) }],
    ['agent_name over 200 characters', { field_name: 'quirk', current_value: 'x', agent_name: 'a'.repeat(201) }],
  ])('enhance-field rejects %s with a 422 before any model call', async (_label, body) => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(enhanceField, 'enhance-field', body);
    expect(res._getStatusCode()).toBe(422);
    expect(mockEnhance).not.toHaveBeenCalled();
  });
});

describe('authoring assistants - success shape', () => {
  it('generate-avatar maps the stored portrait to snake_case and forwards image_model', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(generateAvatar, 'generate-avatar', { image_model: 'gpt-image-1' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ portrait_url: 'https://s3.test/a.png', generation_prompt: 'a portrait' });
    expect(mockAvatar.mock.calls[0][2]).toBe('gpt-image-1');
  });

  it('generate-description returns the description', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(generateDescription, 'generate-description');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ description: 'A curious researcher.' });
  });

  it('generate-system-prompt returns the saved prompt', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(generateSystemPrompt, 'generate-system-prompt');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ system_prompt: 'You are a researcher.' });
    expect(mockSystemPrompt.mock.calls[0][1]).toBe('user-1');
  });

  it('generate-system-prompt reports the per-agent generation interval as a 429', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockSystemPrompt.mockRejectedValue(new SystemPromptRateLimitError('Rate limit exceeded. Please wait 30 seconds.'));
    const res = await fire(generateSystemPrompt, 'generate-system-prompt');
    expect(res._getStatusCode()).toBe(429);
  });

  it('enhance-field maps the snake_case body onto the core and returns the enhanced text', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(enhanceField, 'enhance-field', { ...ENHANCE_BODY, agent_name: 'Ada' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ enhanced_value: 'Hums Bach while thinking.' });
    expect(mockEnhance.mock.calls[0][2]).toEqual({
      fieldName: 'quirk',
      currentValue: 'Hums while thinking',
      agentName: 'Ada',
    });
  });

  it('enhance-field rejects an unknown or camelCase body field with a 422', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(enhanceField, 'enhance-field', { fieldName: 'quirk', currentValue: 'x' });
    expect(res._getStatusCode()).toBe(422);
    expect(mockEnhance).not.toHaveBeenCalled();
  });

  it('generate-avatar rejects an unknown body field with a 422', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(generateAvatar, 'generate-avatar', { imageModel: 'gpt-image-1' });
    expect(res._getStatusCode()).toBe(422);
    expect(mockAvatar).not.toHaveBeenCalled();
  });
});
