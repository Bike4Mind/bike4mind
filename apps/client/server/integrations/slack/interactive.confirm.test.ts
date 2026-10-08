// @vitest-environment node
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));
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
import { cancelPendingActionOnQuest, executePendingAction } from '@server/utils/pendingActionExecutor';
import handler from '../../../pages/api/slack/interactive';

const QUEST_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PENDING_ACTION_TS = 1_700_000_000_000;
const routeHandler = handler as unknown as (request: NextApiRequest, response: NextApiResponse) => Promise<void>;

async function postAction(actionId: 'confirm_action' | 'cancel_action', value: string) {
  const payload = {
    type: 'block_actions',
    user: { id: 'U123' },
    team: { id: 'T123', domain: 'test-workspace' },
    actions: [{ action_id: actionId, value }],
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
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

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
});
