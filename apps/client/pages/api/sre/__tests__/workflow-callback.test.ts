import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const REPO = 'acme/app';
const TOKEN = 'test-callback-token';

const mocks = vi.hoisted(() => ({
  findFullById: vi.fn(),
  atomicTransition: vi.fn(),
  upsertFromFix: vi.fn(),
  getSettingsValue: vi.fn(),
  createInboxMessage: vi.fn(),
  postSreFixSuccessMessage: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  sreErrorTrackingRepository: { findFullById: mocks.findFullById, atomicTransition: mocks.atomicTransition },
  sreErrorPatternRepository: { upsertFromFix: mocks.upsertFromFix },
  adminSettingsRepository: { getSettingsValue: mocks.getSettingsValue },
  inboxRepository: { createInboxMessage: mocks.createInboxMessage },
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  SreAgentConfigSchema: { parse: (v: unknown) => v },
  resolveCallbackToken: () => 'encrypted-token',
  resolveFullConfig: () => ({ slack: {}, maxCiRetries: 2, defaultBranch: 'main' }),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = mocks.loggerError;
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test', SECRET_ENCRYPTION_KEY: 'key' },
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({ decryptSecret: () => TOKEN }));
vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreFixSuccessMessage: mocks.postSreFixSuccessMessage,
  postSreFixFailureMessage: vi.fn(),
  postSreAlreadyFixedMessage: vi.fn(),
  postSreCiRetryMessage: vi.fn(),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: vi.fn() }));
vi.mock('@server/services/githubService', () => ({ GitHubService: { forSystem: vi.fn() } }));

import handler from '../workflow-callback';

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('POST /api/sre/workflow-callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettingsValue.mockResolvedValue({});
    mocks.findFullById.mockResolvedValue({ repoSlug: REPO, affectedUserIds: ['user-1', 'user-2'] });
    mocks.atomicTransition.mockResolvedValue({
      errorMessage: 'TypeError: boom',
      affectedUserIds: ['user-1', 'user-2'],
    });
    mocks.postSreFixSuccessMessage.mockResolvedValue(undefined);
  });

  it('does not send inbox messages to affected users on a success callback', async () => {
    // Success fires when the fix PR is opened, not merged; affected users are notified on merge by
    // PullRequestHandler (the SRE-CONCIERGE block), so notifying here would double-notify an unmerged fix.
    const req = {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {
        fingerprint: 'fp-1',
        trackingId: 'track-1',
        repoSlug: REPO,
        status: 'success',
        prNumber: 42,
        prUrl: `https://github.com/${REPO}/pull/42`,
      },
    } as unknown as NextApiRequest;
    const res = makeRes();

    await handler(req, res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.atomicTransition).toHaveBeenCalledWith('track-1', REPO, 'fixing', 'fixed', expect.any(Object));
    expect(mocks.postSreFixSuccessMessage).toHaveBeenCalledTimes(1);
    expect(mocks.createInboxMessage).not.toHaveBeenCalled();
    // An inbox write through an inboxRepository method the mock does not stub would throw, and the
    // success path swallows its non-fatal errors with logger.error; a clean log pins that too.
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});
