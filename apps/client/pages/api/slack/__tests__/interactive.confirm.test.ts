// @vitest-environment node
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test', STAGE: 'test' },
  isDevelopment: () => false,
}));
vi.mock('@server/integrations/slack/slackWebhookVerification', () => ({
  verifySlackRequest: () => ({ valid: true }),
}));
vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: { create: () => ({ success: vi.fn(), failure: vi.fn() }) },
}));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: () => 'xoxb-test' }));
vi.mock('@server/utils/pendingActionExecutor', () => ({
  executePendingAction: vi.fn(),
  cancelPendingActionOnQuest: vi.fn(),
  isPendingActionRequester: vi.fn(),
  MCP_DISABLED_MESSAGE: 'MCP disabled',
}));
vi.mock('@server/middlewares/featureFlag', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: { findOne: vi.fn() },
  };
});
vi.mock('@bike4mind/database/infra', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database/infra')>('@bike4mind/database/infra');
  return { ...actual, SlackDevWorkspace: { findOne: vi.fn() } };
});
vi.mock('@bike4mind/slack', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/slack')>('@bike4mind/slack');
  return {
    ...actual,
    SlackAuditLogger: { create: () => ({ success: vi.fn(), failure: vi.fn() }) },
  };
});

import { User } from '@bike4mind/database';
import { SlackDevWorkspace } from '@bike4mind/database/infra';
import {
  cancelPendingActionOnQuest,
  executePendingAction,
  isPendingActionRequester,
} from '@server/utils/pendingActionExecutor';
import { isFeatureEnabled } from '@server/middlewares/featureFlag';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import handler from '../interactive';

const QUEST_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PENDING_ACTION_TS = 1_700_000_000_000;
const routeHandler = handler as unknown as (request: NextApiRequest, response: NextApiResponse) => Promise<void>;

async function postAction(
  actionId: string,
  value: string,
  responseUrl?: string,
  extraAction: Record<string, unknown> = {},
  extraPayload: Record<string, unknown> = {}
) {
  const payload = {
    type: 'block_actions',
    user: { id: 'U123' },
    team: { id: 'T123', domain: 'test-workspace' },
    actions: [{ action_id: actionId, value, ...extraAction }],
    ...(responseUrl ? { response_url: responseUrl } : {}),
    ...extraPayload,
  };
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const request = Readable.from([Buffer.from(rawBody)]) as unknown as NextApiRequest;
  request.method = 'POST';
  request.headers = { 'x-slack-signature': 'v0=test', 'x-slack-request-timestamp': '1700000000' };
  const { res } = createMocks();

  await routeHandler(request, res as unknown as NextApiResponse);
  return res;
}

describe('POST /api/slack/interactive confirmation buttons', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.mocked(User.findOne).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(SlackDevWorkspace.findOne).mockReturnValue({
      select: () =>
        Promise.resolve({
          id: 'workspace-1',
          name: 'Test workspace',
          slackOAuthSigningSecret: 'secret',
          slackBotToken: 'encrypted',
        }),
    } as never);
    vi.mocked(executePendingAction).mockResolvedValue({ success: true, message: 'Created' });
    vi.mocked(cancelPendingActionOnQuest).mockResolvedValue({ success: true, message: 'Cancelled' });
    vi.mocked(isPendingActionRequester).mockResolvedValue(true);
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  });

  it.each(['confirm_action', 'cancel_action'] as const)(
    'refuses %s from a user who does not own the quest, leaving the card in place',
    async actionId => {
      vi.mocked(isPendingActionRequester).mockResolvedValue(false);

      const response = await postAction(actionId, `${QUEST_ID}:${PENDING_ACTION_TS}`);

      expect(isPendingActionRequester).toHaveBeenCalledWith(QUEST_ID, 'user-1');
      expect(executePendingAction).not.toHaveBeenCalled();
      expect(cancelPendingActionOnQuest).not.toHaveBeenCalled();
      expect(response._getJSONData()).toMatchObject({ replace_original: false, response_type: 'ephemeral' });
    }
  );

  it.each(['confirm_action', 'cancel_action'] as const)(
    'passes the displayed timestamp through the response_url path for %s',
    async actionId => {
      const responseUrl = 'https://hooks.slack.test/x';
      const response = await postAction(actionId, `${QUEST_ID}:${PENDING_ACTION_TS}`, responseUrl);

      expect(response._getStatusCode()).toBe(200);
      expect(response._getJSONData()).toEqual({});
      if (actionId === 'confirm_action') {
        expect(executePendingAction).toHaveBeenCalledWith(
          QUEST_ID,
          expect.objectContaining({ id: 'user-1' }),
          expect.anything(),
          PENDING_ACTION_TS
        );
        expect(cancelPendingActionOnQuest).not.toHaveBeenCalled();
      } else {
        expect(cancelPendingActionOnQuest).toHaveBeenCalledWith(QUEST_ID, expect.anything(), PENDING_ACTION_TS);
        expect(executePendingAction).not.toHaveBeenCalled();
      }
      const lastCall = vi.mocked(fetch).mock.calls.at(-1);
      expect(lastCall?.[0]).toBe(responseUrl);
      expect(lastCall?.[1]?.method).toBe('POST');
      const posted = JSON.parse(String(lastCall?.[1]?.body)) as { text: string; replace_original: boolean };
      expect(posted.replace_original).toBe(true);
      expect(posted.text).toContain(actionId === 'confirm_action' ? 'Created' : 'Cancelled');
    }
  );

  it.each(['confirm_action', 'cancel_action'] as const)('passes the displayed timestamp through %s', async actionId => {
    const response = await postAction(actionId, `${QUEST_ID}:${PENDING_ACTION_TS}`);

    expect(response._getStatusCode()).toBe(200);
    if (actionId === 'confirm_action') {
      expect(executePendingAction).toHaveBeenCalledWith(
        QUEST_ID,
        expect.objectContaining({ id: 'user-1' }),
        expect.anything(),
        PENDING_ACTION_TS
      );
      expect(cancelPendingActionOnQuest).not.toHaveBeenCalled();
      return;
    }
    expect(cancelPendingActionOnQuest).toHaveBeenCalledWith(QUEST_ID, expect.anything(), PENDING_ACTION_TS);
    expect(executePendingAction).not.toHaveBeenCalled();
  });

  it.each(['confirm_action', 'cancel_action'] as const)('accepts a legacy bare quest ID for %s', async actionId => {
    const response = await postAction(actionId, QUEST_ID);

    expect(response._getStatusCode()).toBe(200);
    if (actionId === 'confirm_action') {
      expect(executePendingAction).toHaveBeenCalledWith(QUEST_ID, expect.anything(), expect.anything(), undefined);
      return;
    }
    expect(cancelPendingActionOnQuest).toHaveBeenCalledWith(QUEST_ID, expect.anything(), undefined);
  });

  it.each(['confirm_action', 'cancel_action'] as const)(
    'refuses %s from a bystander on the response_url path with an ephemeral reply',
    async actionId => {
      vi.mocked(isPendingActionRequester).mockResolvedValue(false);
      const responseUrl = 'https://hooks.slack.test/x';

      await postAction(actionId, `${QUEST_ID}:${PENDING_ACTION_TS}`, responseUrl);

      expect(executePendingAction).not.toHaveBeenCalled();
      expect(cancelPendingActionOnQuest).not.toHaveBeenCalled();
      const lastCall = vi.mocked(fetch).mock.calls.at(-1);
      expect(lastCall?.[0]).toBe(responseUrl);
      const posted = JSON.parse(String(lastCall?.[1]?.body)) as { replace_original: boolean; response_type: string };
      expect(posted.replace_original).toBe(false);
      expect(posted.response_type).toBe('ephemeral');
    }
  );

  describe('with the MCP admin flag off', () => {
    const responseUrl = 'https://hooks.slack.test/x';

    beforeEach(() => {
      vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    });

    function lastPosted() {
      const lastCall = vi.mocked(fetch).mock.calls.at(-1);
      expect(lastCall?.[0]).toBe(responseUrl);
      return JSON.parse(String(lastCall?.[1]?.body)) as { text: string; response_type?: string };
    }

    it('answers an attachment download ephemerally without calling MCP', async () => {
      await postAction('attachment_menu_1', '', responseUrl, {
        selected_option: { value: `download:${QUEST_ID}:0` },
      });

      expect(isFeatureEnabled).toHaveBeenCalledWith('EnableMCPServer');
      expect(invokeMcpHandler).not.toHaveBeenCalled();
      const posted = lastPosted();
      expect(posted.text).toContain('MCP disabled');
      expect(posted.response_type).toBe('ephemeral');
    });

    it('answers an attachment download ephemerally when there is no response_url', async () => {
      const response = await postAction('attachment_menu_1', '', undefined, {
        selected_option: { value: `download:${QUEST_ID}:0` },
      });

      expect(invokeMcpHandler).not.toHaveBeenCalled();
      expect(response._getJSONData()).toMatchObject({
        text: expect.stringContaining('MCP disabled'),
        response_type: 'ephemeral',
      });
    });

    it('answers an attachment delete confirmed from the modal without calling MCP', async () => {
      const privateMetadata = JSON.stringify({ buttonValue: `${QUEST_ID}:0`, responseUrl });

      await postAction(
        'modal_confirm_att_del',
        '',
        undefined,
        {},
        {
          view: {
            id: 'V1',
            callback_id: 'confirm_att_del_modal',
            state: { values: {} },
            private_metadata: privateMetadata,
          },
        }
      );

      expect(isFeatureEnabled).toHaveBeenCalledWith('EnableMCPServer');
      expect(invokeMcpHandler).not.toHaveBeenCalled();
      expect(lastPosted().text).toContain('MCP disabled');
    });
  });
});
