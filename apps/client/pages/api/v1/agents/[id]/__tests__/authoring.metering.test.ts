// @vitest-environment node
/**
 * The /api/v1 authoring routes hand their helper a request-billed system-model meter and keep the 422 of
 * a credit refusal. The helpers are stubbed; the meter wiring and the error mapping are the real route code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  assertOutboundActionAllowed: async () => undefined,
}));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@server/utils/withRequestCompletionQuota', () => ({
  withRequestCompletionQuota: (fn: unknown) => fn,
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => undefined }));

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  current: '',
  enhance: vi.fn(),
  describeAgent: vi.fn(),
  systemPrompt: vi.fn(),
  avatar: vi.fn(),
  meter: vi.fn(),
  requestMeter: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handlers[h.current] = fn;
      return {};
    },
  }),
}));
vi.mock('@server/agents/v1AgentRoute', () => ({
  AUTHORING_RATE_LIMIT_BUCKET: 'test',
  findOwnedAgent: async () => ({ id: 'a1', userId: 'u1' }),
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  checkStorageLimit: async () => undefined,
}));
vi.mock('@server/agents/authoring/enhanceAgentField', () => ({ enhanceAgentField: h.enhance }));
vi.mock('@server/agents/authoring/generateAgentDescription', () => ({ generateAgentDescription: h.describeAgent }));
vi.mock('@server/agents/authoring/generateAgentSystemPrompt', () => ({ generateAgentSystemPrompt: h.systemPrompt }));
vi.mock('@server/agents/authoring/generateAgentAvatar', () => ({ generateAgentAvatar: h.avatar }));
vi.mock('@server/agents/systemPromptRateLimit', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logSystemPromptGenerationFailure: vi.fn(),
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createRequestCompletionMeter: (...args: unknown[]) => (h.requestMeter(...args), h.meter),
}));

h.current = 'enhance-field';
await import('../enhance-field');
h.current = 'generate-description';
await import('../generate-description');
h.current = 'generate-system-prompt';
await import('../generate-system-prompt');
h.current = 'generate-avatar';
await import('../generate-avatar');

const ROUTES = [
  ['enhance-field', h.enhance, { field_name: 'quirk', current_value: 'x' }],
  ['generate-description', h.describeAgent, {}],
  ['generate-system-prompt', h.systemPrompt, {}],
  ['generate-avatar', h.avatar, {}],
] as const;

function call(route: string, body: Record<string, unknown>) {
  const req = {
    validatedParams: { id: 'a1' },
    validated: body,
    user: { id: 'u1', tags: [], groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  };
  const res = { json: vi.fn().mockReturnThis() };
  return { req, res, done: h.handlers[route](req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(ROUTES)('POST /api/v1/agents/{id}/%s metering', (route, helper, body) => {
  it('passes the helper a request-billed system-model meter', async () => {
    helper.mockResolvedValue(route === 'generate-avatar' ? { portraitUrl: 'u', generationPrompt: 'p' } : 'text');

    const { req, done } = call(route, { ...body });
    await done;

    expect(h.requestMeter).toHaveBeenCalledWith(req, expect.any(String), { systemModel: true });
    expect(helper.mock.calls[0]).toContain(h.meter);
  });

  it('keeps the 422 of a credit refusal', async () => {
    helper.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    const { done } = call(route, { ...body });

    await expect(done).rejects.toMatchObject({ statusCode: 422 });
  });
});
