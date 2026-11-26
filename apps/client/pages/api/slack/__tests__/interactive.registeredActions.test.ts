// @vitest-environment node
import { Readable } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@bike4mind/observability';
import { SLACK_API_POST_EVENT_TYPE } from '@bike4mind/common';

const approvals = vi.hoisted(() => ({ sre: vi.fn() }));
const audit = vi.hoisted(() => ({ success: vi.fn(), failure: vi.fn() }));
const contributed = vi.hoisted(() => {
  const handlers = {
    exact: vi.fn(),
    prefix: vi.fn(),
    claimsCore: vi.fn(),
    claimsReservedId: vi.fn(),
    claimsReservedPrefix: vi.fn(),
  };
  return {
    handlers,
    entries: [
      { actionIds: ['ext_widget_ping'], handle: handlers.exact },
      { actionIdPrefixes: ['ext_menu_'], handle: handlers.prefix },
      // Each entry below is left out whole: one of its claims is a core or a reserved action.
      { actionIds: ['ext_unrelated', 'sre_approve_fix'], handle: handlers.claimsCore },
      { actionIds: ['confirm_action'], handle: handlers.claimsReservedId },
      { actionIdPrefixes: ['app_home_notebook_'], handle: handlers.claimsReservedPrefix },
    ] as unknown[],
  };
});

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@server/slack/resolveSlackInstallation', () => ({ resolveSlackInstallation: vi.fn() }));
const testSlackInstallation = {
  ok: true as const,
  installation: {
    kind: 'dev' as const,
    signingSecret: 'secret',
    botToken: 'xoxb-test',
    workspace: { id: 'workspace-1', name: 'Test workspace' } as never,
    workspaceWithCreds: { id: 'workspace-1', name: 'Test workspace', slackBotName: 'test-bot' } as never,
  },
};
vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test', STAGE: 'test' },
  isDevelopment: () => false,
}));
vi.mock('@server/integrations/slack/slackWebhookVerification', () => ({
  verifySlackRequest: () => ({ valid: true }),
}));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: { create: () => ({ success: vi.fn(), failure: vi.fn() }) },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: () => 'xoxb-test' }));
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: { findOne: vi.fn() },
  };
});
vi.mock('@bike4mind/server-utils/integrations/slack/sreSlackApproval', () => ({
  handleSreApprovalAction: approvals.sre,
}));
vi.mock('@bike4mind/server-utils/premium-generated/premiumSlackInteractiveActions.generated', () => ({
  premiumSlackInteractiveActions: contributed.entries,
}));
vi.mock('@bike4mind/slack', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/slack')>('@bike4mind/slack');
  return { ...actual, SlackAuditLogger: { create: () => audit } };
});

import { User } from '@bike4mind/database';
import { resolveSlackInstallation } from '@server/slack/resolveSlackInstallation';
import handler from '../interactive';

const routeHandler = handler as unknown as (request: NextApiRequest, response: NextApiResponse) => Promise<void>;

const SLACK_USER = { id: 'U1', name: 'alice', username: 'alice.u' };
const RESPONSE_URL = 'https://hooks.slack.test/response';

function signedRequest(payload: Record<string, unknown>) {
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const request = Readable.from([Buffer.from(rawBody)]) as unknown as NextApiRequest;
  request.method = 'POST';
  request.headers = { 'x-slack-signature': 'v0=test', 'x-slack-request-timestamp': '1700000000' };
  return request;
}

function blockAction(actionId: string, value: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    user: SLACK_USER,
    team: { id: 'T1', domain: 'test-workspace' },
    channel: { id: 'C1' },
    actions: [{ action_id: actionId, ...(value === undefined ? {} : { value }) }],
    response_url: RESPONSE_URL,
    trigger_id: 'trigger-1',
    ...extra,
  };
}

/** Posts a payload; `events` records the order of the response, deferred work and handler completion. */
async function post(payload: Record<string, unknown>, events: string[] = []) {
  const { res } = createMocks();
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    events.push('responded');
    return originalJson(body);
  }) as typeof res.json;

  await routeHandler(signedRequest(payload), res as unknown as NextApiResponse);
  events.push('handler-resolved');
  return res;
}

/** A handler result whose deferred work settles a few ms later, after the response has been sent. */
function resultWithDeferred(response: Record<string, unknown>, events: string[]) {
  return {
    response,
    deferred: new Promise<void>(resolve => setTimeout(resolve, 5)).then(() => {
      events.push('deferred-settled');
    }),
  };
}

const FAMILIES = [
  {
    family: 'sre',
    actionIds: ['sre_approve_fix', 'sre_reject_fix'],
    mock: approvals.sre,
    expectedArgs: (actionId: string) => [actionId, 'proposal-1', SLACK_USER, RESPONSE_URL],
  },
];

describe('POST /api/slack/interactive registered actions', () => {
  const errorLogs: unknown[][] = [];

  beforeAll(() => {
    vi.spyOn(Logger, 'error').mockImplementation((...args: unknown[]) => {
      errorLogs.push(args);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.mocked(User.findOne).mockResolvedValue(null as never);
    vi.mocked(resolveSlackInstallation).mockResolvedValue(testSlackInstallation);
  });

  describe.each(FAMILIES)('$family approval actions', ({ actionIds, mock, expectedArgs }) => {
    it.each(actionIds)('%s calls the approval handler once and answers with its response', async actionId => {
      mock.mockResolvedValue({ response: { text: `handled ${actionId}` } });

      const res = await post(blockAction(actionId, 'proposal-1'));

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(...expectedArgs(actionId));
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ text: `handled ${actionId}` });
    });

    it.each(actionIds)(
      '%s skips the account lookup and settles its deferred work after the response',
      async actionId => {
        const events: string[] = [];
        mock.mockImplementation(async () => resultWithDeferred({ text: 'ack' }, events));

        await post(blockAction(actionId, 'proposal-1'), events);

        expect(User.findOne).not.toHaveBeenCalled();
        expect(events).toEqual(['responded', 'deferred-settled', 'handler-resolved']);
      }
    );
  });

  it.each(['sre_approve_fix', 'sre_reject_fix'])(
    '%s on an API-posted message never reaches an approval handler',
    async actionId => {
      const res = await post(
        blockAction(actionId, 'proposal-1', {
          message: { ts: '1700000000.000100', metadata: { event_type: SLACK_API_POST_EVENT_TYPE } },
        })
      );

      expect(approvals.sre).not.toHaveBeenCalled();
      expect(User.findOne).not.toHaveBeenCalled();
      expect(res._getJSONData()).toEqual({});
    }
  );

  it.each(['sre_view_github_issue_123', 'sre_review_github_issue_fix_loop'])(
    '%s link button is acknowledged without an account lookup',
    async actionId => {
      const res = await post(blockAction(actionId, undefined));

      expect(res._getJSONData()).toEqual({});
      expect(User.findOne).not.toHaveBeenCalled();
    }
  );

  describe('contributed handlers', () => {
    const FULL_CONTEXT = {
      value: 'v1',
      user: SLACK_USER,
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1700000000.000200',
      responseUrl: RESPONSE_URL,
      triggerId: 'trigger-1',
      workspaceId: 'workspace-1',
      botToken: 'xoxb-test',
      appName: 'test-bot',
    };

    it.each([
      ['an exact id', 'ext_widget_ping', contributed.handlers.exact],
      ['a prefix', 'ext_menu_42', contributed.handlers.prefix],
    ])(
      'dispatches by %s with the full context, skips the account lookup and awaits deferred work',
      async (_label, actionId, handle) => {
        const events: string[] = [];
        handle.mockImplementation(async () => resultWithDeferred({ text: 'contributed ack' }, events));

        const res = await post(blockAction(actionId, 'v1', { message: { ts: '1700000000.000200' } }), events);

        expect(handle).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledWith({ actionId, ...FULL_CONTEXT });
        expect(res._getJSONData()).toEqual({ text: 'contributed ack' });
        expect(User.findOne).not.toHaveBeenCalled();
        expect(events).toEqual(['responded', 'deferred-settled', 'handler-resolved']);
      }
    );

    it('does not dispatch an entry that claims a core-registered id, and the core handler runs', async () => {
      approvals.sre.mockResolvedValue({ response: { text: 'core sre' } });

      const res = await post(blockAction('sre_approve_fix', 'proposal-1'));

      expect(approvals.sre).toHaveBeenCalledTimes(1);
      expect(contributed.handlers.claimsCore).not.toHaveBeenCalled();
      expect(res._getJSONData()).toEqual({ text: 'core sre' });
    });

    it('leaves out the other claims of a rejected entry too', async () => {
      const res = await post(blockAction('ext_unrelated', undefined));

      expect(contributed.handlers.claimsCore).not.toHaveBeenCalled();
      expect(User.findOne).toHaveBeenCalledTimes(1);
      expect(res._getJSONData()).toMatchObject({ text: expect.stringContaining('User not found') });
    });

    it.each([
      ['an id', 'confirm_action', contributed.handlers.claimsReservedId],
      ['a prefix', 'app_home_notebook_abc', contributed.handlers.claimsReservedPrefix],
    ])('does not dispatch an entry that claims %s the endpoint handles itself', async (_label, actionId, handle) => {
      const res = await post(blockAction(actionId, 'v1'));

      expect(handle).not.toHaveBeenCalled();
      expect(User.findOne).toHaveBeenCalledTimes(1);
      expect(res._getJSONData()).toMatchObject({ text: expect.stringContaining('User not found') });
    });

    it('logs the left-out entries once, on the first dispatch', async () => {
      await post(blockAction('not_registered_anywhere', undefined));
      await post(blockAction('not_registered_anywhere', undefined));

      const problemLogs = errorLogs.filter(args => String(args[0]).includes('Left out contributed action handlers'));
      expect(problemLogs).toHaveLength(1);
      const { problems } = problemLogs[0][1] as { problems: string[] };
      expect(problems).toHaveLength(3);
      expect(problems[0]).toContain('sre_approve_fix');
      expect(problems[1]).toContain('confirm_action');
      expect(problems[2]).toContain('app_home_notebook_');
    });
  });

  describe('a failing registered handler', () => {
    it('answers 500 and records an audit failure when handle rejects', async () => {
      approvals.sre.mockRejectedValue(new Error('boom'));

      const res = await post(blockAction('sre_approve_fix', 'proposal-1'));

      expect(res._getStatusCode()).toBe(500);
      expect(res._getJSONData()).toEqual({ error: 'Internal server error' });
      expect(audit.failure).toHaveBeenCalledTimes(1);
      expect(audit.success).not.toHaveBeenCalled();
      expect(User.findOne).not.toHaveBeenCalled();
    });

    it('keeps the 200 response and logs when deferred work rejects after it', async () => {
      // Rejected inside the handler so it is never left unhandled before the endpoint attaches its catch.
      approvals.sre.mockImplementation(async () => ({
        response: { text: 'ack' },
        deferred: Promise.reject(new Error('late failure')),
      }));

      const res = await post(blockAction('sre_approve_fix', 'proposal-1'));

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ text: 'ack' });
      expect(audit.failure).not.toHaveBeenCalled();
      expect(errorLogs.some(args => String(args[0]).includes('Deferred work failed'))).toBe(true);
    });
  });

  it('sends an unregistered, unreserved id through the account lookup', async () => {
    const res = await post(blockAction('not_registered_anywhere', undefined));

    expect(User.findOne).toHaveBeenCalledTimes(1);
    expect(res._getJSONData()).toMatchObject({
      text: expect.stringContaining('User not found'),
      response_type: 'ephemeral',
    });
  });

  it('refuses a request whose app and team match no installation', async () => {
    vi.mocked(resolveSlackInstallation).mockResolvedValue({ ok: false, reason: 'not_found' });

    const res = await post(blockAction('sre_approve_fix', 'proposal-1'));

    expect(res._getStatusCode()).toBe(404);
    expect(approvals.sre).not.toHaveBeenCalled();
  });
});
