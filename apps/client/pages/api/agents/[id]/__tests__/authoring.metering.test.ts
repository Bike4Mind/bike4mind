// @vitest-environment node
/**
 * The SPA authoring routes hand their helper a request-billed meter and let a credit refusal (422)
 * through instead of remapping it to their generic 400/500 body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  assertOutboundActionAllowed: async () => undefined,
}));
vi.mock('@server/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@server/utils/withRequestCompletionQuota', () => ({
  withRequestCompletionQuota: (fn: unknown) => fn,
}));

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  current: '',
  enhance: vi.fn(),
  describeAgent: vi.fn(),
  systemPrompt: vi.fn(),
  meter: vi.fn(),
  requestMeter: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handlers[h.current] = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({ agentRepository: { findById: async () => ({ id: 'a1', userId: 'u1' }) } }));
vi.mock('@server/agents/assertAgentAccess', () => ({ assertAgentAccess: vi.fn() }));
vi.mock('@server/agents/authoring/enhanceAgentField', () => ({ enhanceAgentField: h.enhance }));
vi.mock('@server/agents/authoring/generateAgentDescription', () => ({ generateAgentDescription: h.describeAgent }));
vi.mock('@server/agents/authoring/generateAgentSystemPrompt', () => ({ generateAgentSystemPrompt: h.systemPrompt }));
vi.mock('@server/agents/systemPromptRateLimit', () => ({ logSystemPromptGenerationFailure: vi.fn() }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createRequestCompletionMeter: (...args: unknown[]) => (h.requestMeter(...args), h.meter),
}));

h.current = 'enhance-field';
await import('../enhance-field');
h.current = 'generate-description';
await import('../generate-description');
h.current = 'generate-system-prompt';
await import('../generate-system-prompt');

const ROUTES = [
  ['enhance-field', h.enhance, { fieldName: 'personalMission', currentValue: 'x' }],
  ['generate-description', h.describeAgent, {}],
  ['generate-system-prompt', h.systemPrompt, {}],
] as const;

function call(route: string, body: Record<string, unknown>) {
  const req = {
    query: { id: 'a1' },
    body,
    user: { id: 'u1', tags: [], groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return { req, res, done: h.handlers[route](req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(ROUTES)('POST /api/agents/[id]/%s metering', (route, helper, body) => {
  it('passes the helper a request-billed system-model meter', async () => {
    helper.mockResolvedValue('text');

    const { req, done } = call(route, { ...body });
    await done;

    expect(h.requestMeter).toHaveBeenCalledWith(req, expect.any(String), { systemModel: true });
    expect(helper.mock.calls[0]).toContain(h.meter);
  });

  it('keeps the 422 of a credit refusal instead of remapping it', async () => {
    helper.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    const { res, done } = call(route, { ...body });

    await expect(done).rejects.toMatchObject({ statusCode: 422 });
    expect(res.status).not.toHaveBeenCalled();
  });
});
