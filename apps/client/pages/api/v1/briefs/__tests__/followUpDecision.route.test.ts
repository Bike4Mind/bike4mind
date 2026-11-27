// @vitest-environment node
/**
 * PATCH /api/v1/briefs/{id}/decisions/{decisionId} and POST .../resolve. `baseApi` is stubbed but
 * `nextRouteForContract` is not, so request validation runs for real; the repositories are mocked.
 */
import { HTTPError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { httpErrorToResponse } from '@server/middlewares/errorHandler';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assistantBriefRepository, userRepository, baseApiOptions } = vi.hoisted(() => ({
  assistantBriefRepository: {
    findByIdForUser: vi.fn(),
    editFollowUpDecision: vi.fn(),
    resolveFollowUpDecision: vi.fn(),
  },
  userRepository: { pullNextBriefAtForward: vi.fn() },
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: vi.fn(),
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: (err?: unknown) => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          let failure: unknown;
          await handler(req, res, err => {
            advanced = true;
            failure = err;
          });
          if (failure) throw failure;
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = compose;
    chain.patch = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({ assistantBriefRepository, userRepository }));
vi.mock('@server/briefs/serializeBrief', () => ({
  serializeBrief: async (brief: { decisions: unknown[] }) => ({ decisions: brief.decisions }),
}));

const { default: editHandler } = await import('../[id]/decisions/[decisionId]/index');
const { default: resolveHandler } = await import('../[id]/decisions/[decisionId]/resolve');

const REMIND_AT = new Date('2026-11-26T14:00:00.000Z');
const decisions = () => [
  { id: 'fu-action-1', text: 'Book the room', followUp: { kind: 'actionItem', state: 'pending', remindAt: null } },
  {
    id: 'fu-email',
    text: 'Send follow-up to Sam',
    followUp: { kind: 'followUpEmail', state: 'pending', remindAt: null },
    draftReply: { to: 'Sam', subject: 'Notes', body: 'Here are the notes.' },
  },
  {
    id: 'fu-reminder-1',
    text: 'Call the vendor',
    followUp: { kind: 'reminder', state: 'pending', remindAt: REMIND_AT },
  },
  { id: 'fu-reminder-2', text: 'Sometime', followUp: { kind: 'reminder', state: 'pending', remindAt: null } },
  { id: 'fu-done', text: 'Done', followUp: { kind: 'actionItem', state: 'approved', remindAt: null } },
  { id: 'approval-1', text: 'Approve the run', approval: { questId: 'q1' } },
];
let brief: { decisions: ReturnType<typeof decisions> };

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const call = async (method: 'PATCH' | 'POST', decisionId: string, body: unknown, userId = 'user-1') => {
  const { req, res } = createMocks({
    method,
    query: { id: 'brief-1', decisionId },
    body: body as Record<string, unknown>,
  });
  Object.assign(req, { user: { id: userId }, logger });
  const handler = method === 'PATCH' ? editHandler : resolveHandler;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};
const edit = (decisionId: string, body: unknown, userId?: string) => call('PATCH', decisionId, body, userId);
const resolve = (decisionId: string, outcome: string, userId?: string) => call('POST', decisionId, { outcome }, userId);
// What a real client receives: baseApi's errorHandler renders a thrown HTTPError through this.
const onTheWire = async (request: Promise<unknown>) => {
  const error = await request.then(
    () => expect.fail('expected the route to throw'),
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(HTTPError);
  return httpErrorToResponse(error as HTTPError, 'req-1');
};

describe('follow-up decision routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brief = { decisions: decisions() };
    assistantBriefRepository.findByIdForUser.mockImplementation(async (_id: string, userId: string) =>
      userId === 'user-1' ? brief : null
    );
    assistantBriefRepository.editFollowUpDecision.mockResolvedValue(true);
    assistantBriefRepository.resolveFollowUpDecision.mockResolvedValue(true);
    userRepository.pullNextBriefAtForward.mockResolvedValue(true);
  });

  it('builds both routes JWT-only', () => {
    expect(baseApiOptions).toHaveLength(2);
    for (const options of baseApiOptions) expect(options).toMatchObject({ auth: 'jwtOnly' });
  });

  it.each([
    ["another user's brief", 'fu-email', 'user-2'],
    ['a missing decision', 'nope', 'user-1'],
    ['an approval decision', 'approval-1', 'user-1'],
  ])('404s %s on edit and resolve without writing', async (_label, decisionId, userId) => {
    await expect(edit(decisionId, { text: 'x' }, userId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolve(decisionId, 'approve', userId)).rejects.toMatchObject({ statusCode: 404 });
    expect(assistantBriefRepository.editFollowUpDecision).not.toHaveBeenCalled();
    expect(assistantBriefRepository.resolveFollowUpDecision).not.toHaveBeenCalled();
  });

  it('edits the email draft and answers with the decision', async () => {
    const res = await edit('fu-email', { draftReply: { to: 'sam@example.com' } });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'fu-email' });
    expect(assistantBriefRepository.editFollowUpDecision).toHaveBeenCalledWith('brief-1', 'user-1', 'fu-email', {
      text: undefined,
      draftReply: { to: 'sam@example.com' },
      remindAt: undefined,
    });
  });

  it('passes a reminder time through as a Date', async () => {
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await edit('fu-reminder-2', { remindAt: at.toISOString() });
    expect(assistantBriefRepository.editFollowUpDecision.mock.calls[0][3].remindAt).toEqual(at);
  });

  it.each([
    ['in the past', -60_000],
    ['more than a year ahead', 367 * 24 * 60 * 60 * 1000],
  ])('400s a reminder time %s', async (_label, offsetMs) => {
    const at = new Date(Date.now() + offsetMs).toISOString();
    await expect(edit('fu-reminder-2', { remindAt: at })).rejects.toMatchObject({ statusCode: 400 });
    expect(assistantBriefRepository.editFollowUpDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft on an action item', 'fu-action-1', { draftReply: { to: 'a@example.com' } }],
    ['a reminder time on an email', 'fu-email', { remindAt: '2026-11-27T09:00:00Z' }],
  ])('400s %s', async (_label, decisionId, body) => {
    await expect(edit(decisionId, body)).rejects.toMatchObject({ statusCode: 400 });
    expect(assistantBriefRepository.editFollowUpDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty body', {}],
    ['an empty draft', { draftReply: {} }],
    ['a blank text', { text: '   ' }],
    ['a time with no zone', { remindAt: '2026-11-27T09:00:00' }],
  ])('rejects %s before anything is read', async (_label, body) => {
    await expect(edit('fu-email', body)).rejects.toMatchObject({ name: 'ZodError' });
    expect(assistantBriefRepository.findByIdForUser).not.toHaveBeenCalled();
  });

  it('409s an edit after the follow-up was resolved, and an edit that loses the race', async () => {
    await expect(onTheWire(edit('fu-done', { text: 'x' }))).resolves.toMatchObject({
      status: 409,
      body: { errorCode: 'decision_closed' },
    });
    assistantBriefRepository.editFollowUpDecision.mockResolvedValue(false);
    await expect(onTheWire(edit('fu-action-1', { text: 'x' }))).resolves.toMatchObject({
      status: 409,
      body: { errorCode: 'decision_closed' },
    });
  });

  it('rejects an unknown outcome', async () => {
    await expect(resolve('fu-action-1', 'send')).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('400s approving an email whose recipient is not an address, then approves once it is', async () => {
    await expect(resolve('fu-email', 'approve')).rejects.toMatchObject({ statusCode: 400 });
    expect(assistantBriefRepository.resolveFollowUpDecision).not.toHaveBeenCalled();
    brief.decisions[1].draftReply = { to: 'sam@example.com', subject: 'Notes', body: 'Here are the notes.' };
    const res = await resolve('fu-email', 'approve');
    expect(res._getStatusCode()).toBe(200);
    expect(assistantBriefRepository.resolveFollowUpDecision).toHaveBeenCalledWith(
      'brief-1',
      'user-1',
      'fu-email',
      'approved',
      expect.any(Date),
      { to: 'sam@example.com' }
    );
    expect(userRepository.pullNextBriefAtForward).not.toHaveBeenCalled();
  });

  it('400s approving a reminder with no time, but lets it be dismissed', async () => {
    await expect(resolve('fu-reminder-2', 'approve')).rejects.toMatchObject({ statusCode: 400 });
    await resolve('fu-reminder-2', 'dismiss');
    expect(assistantBriefRepository.resolveFollowUpDecision).toHaveBeenCalledWith(
      'brief-1',
      'user-1',
      'fu-reminder-2',
      'dismissed',
      expect.any(Date),
      {}
    );
    expect(userRepository.pullNextBriefAtForward).not.toHaveBeenCalled();
  });

  it('approving a reminder pulls the next scheduled brief forward to it', async () => {
    await resolve('fu-reminder-1', 'approve');
    expect(userRepository.pullNextBriefAtForward).toHaveBeenCalledWith('user-1', REMIND_AT);
    expect(assistantBriefRepository.resolveFollowUpDecision.mock.calls[0][5]).toEqual({ remindAt: REMIND_AT });
  });

  it('keeps the approval when the pull-forward fails', async () => {
    userRepository.pullNextBriefAtForward.mockRejectedValue(new Error('db down'));
    const res = await resolve('fu-reminder-1', 'approve');
    expect(res._getStatusCode()).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('409s a second approve and never pulls forward for it', async () => {
    assistantBriefRepository.resolveFollowUpDecision.mockResolvedValue(false);
    await expect(onTheWire(resolve('fu-reminder-1', 'approve'))).resolves.toMatchObject({
      status: 409,
      body: { errorCode: 'decision_closed' },
    });
    expect(userRepository.pullNextBriefAtForward).not.toHaveBeenCalled();
  });
});
