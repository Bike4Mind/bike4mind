// @vitest-environment node
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@bike4mind/observability';

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
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
    User: { findOne: vi.fn().mockRejectedValue(new Error('lookup failed')) },
  };
});
vi.mock('@bike4mind/database/infra', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database/infra')>('@bike4mind/database/infra');
  return {
    ...actual,
    SlackDevWorkspace: { findOne: vi.fn() },
    slackDevWorkspaceRepository: {
      findAllActive: vi.fn().mockResolvedValue([{ id: 'workspace-1' }]),
      findByIdWithCredentials: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'Test workspace',
        slackOAuthSigningSecret: 'secret',
        slackBotToken: 'encrypted',
      }),
    },
  };
});
vi.mock('@bike4mind/server-utils/integrations/slack/sreSlackApproval', async () => {
  const { Logger: MockLogger } = await import('@bike4mind/observability');
  return {
    handleSreApprovalAction: () => ({
      response: {},
      deferred: new Promise(resolve => setTimeout(resolve, 5)).then(() => MockLogger.info('[test] post-ack deferred')),
    }),
  };
});
vi.mock('@bike4mind/slack', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/slack')>('@bike4mind/slack');
  return {
    ...actual,
    SlackAuditLogger: { create: () => ({ success: vi.fn(), failure: vi.fn(), setUserId: vi.fn() }) },
  };
});

import { SlackDevWorkspace } from '@bike4mind/database/infra';
import commandsHandler from '../commands';
import interactiveHandler from '../interactive';

const STALE = { path: '/api/mcp-servers', requestId: 'stale', userId: 'u-foreign', method: 'GET' };
let logSpies: Array<ReturnType<typeof vi.spyOn>>;

function loggedLines() {
  return logSpies
    .flatMap(spy => spy.mock.calls.map(call => String(call[0])))
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function loggedMessages() {
  return loggedLines().map(line => String(line.message));
}

function expectOwnContext(lines: Array<Record<string, unknown>>, path: string) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatchObject({ path, requestId: 'slack-1', method: 'POST' });
    expect(line.userId).not.toBe(STALE.userId);
  }
}

function signedRequest(url: string, body: Record<string, unknown>) {
  const request = Readable.from([Buffer.from(new URLSearchParams(body as Record<string, string>).toString())]);
  Object.assign(request, {
    method: 'POST',
    url,
    body,
    headers: { 'x-slack-signature': 'v0=test', 'x-slack-request-timestamp': '1700000000', 'x-request-id': 'slack-1' },
  });
  return request as unknown as NextApiRequest;
}

describe('slack handlers log with their own request context', () => {
  beforeEach(() => {
    logSpies = (['debug', 'info', 'warn', 'error'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation(() => {})
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    Logger.updateMetadata(STALE);
  });

  afterEach(() => {
    Logger.resetMetadata();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('commands: post-ack static logs carry the slash-command request', async () => {
    const { res } = createMocks();
    await commandsHandler(
      signedRequest('/api/slack/commands?x=1', {
        token: 't',
        team_id: 'T1',
        team_domain: 'd',
        channel_id: 'C1',
        channel_name: 'c',
        user_id: 'U1',
        user_name: 'u',
        command: '/channel',
        text: 'help',
        response_url: 'https://hooks.example/resp',
        trigger_id: 'trig',
      }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(200);
    expectOwnContext(loggedLines(), '/api/slack/commands');
    expect(loggedMessages().some(message => message.includes('Error processing command'))).toBe(true);
  });

  it('interactive: static logs carry the interactive request', async () => {
    vi.mocked(SlackDevWorkspace.findOne).mockReturnValue({
      select: () => Promise.resolve({ id: 'w', slackOAuthSigningSecret: 's', slackBotToken: 'e' }),
    } as never);
    const { res } = createMocks();
    await interactiveHandler(
      signedRequest('/api/slack/interactive', {
        payload: JSON.stringify({
          type: 'block_actions',
          user: { id: 'U1' },
          team: { id: 'T1', domain: 'd' },
          actions: [{ action_id: 'sre_approve_fix', value: 'v' }],
          response_url: 'https://hooks.example/resp',
        }),
      }),
      res as unknown as NextApiResponse
    );

    expect(res._isEndCalled()).toBe(true);
    expect(res.statusCode).toBe(200);
    expectOwnContext(loggedLines(), '/api/slack/interactive');
    expect(loggedMessages()).toContain('[test] post-ack deferred');
  });
});
