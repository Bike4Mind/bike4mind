import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

const REPO = 'acme/app';
const TOKEN = 'callback-token-fixture';

const mocks = vi.hoisted(() => ({
  config: {
    MONGODB_URI: 'mongodb://x/%STAGE%',
    STAGE: 'test',
    SECRET_ENCRYPTION_KEY: undefined as string | undefined,
    SECRET_ENCRYPTION_KEY_PREVIOUS: undefined as string | undefined,
  },
  storedToken: '',
  findFullById: vi.fn(),
  atomicTransition: vi.fn(),
  getSettingsValue: vi.fn(),
  postSreFixSuccessMessage: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  sreErrorTrackingRepository: { findFullById: mocks.findFullById, atomicTransition: mocks.atomicTransition },
  sreErrorPatternRepository: { upsertFromFix: vi.fn() },
  adminSettingsRepository: { getSettingsValue: mocks.getSettingsValue },
  inboxRepository: { createInboxMessage: vi.fn() },
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  SreAgentConfigSchema: { parse: (v: unknown) => v },
  resolveCallbackToken: () => mocks.storedToken,
  resolveFullConfig: () => ({ slack: {}, maxCiRetries: 2, defaultBranch: 'main' }),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: Object.assign(
    class {
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
    { error: vi.fn() }
  ),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: mocks.config }));
vi.mock('@bike4mind/server-utils/integrations/slack/sreSlackApproval', () => ({
  postSreFixSuccessMessage: mocks.postSreFixSuccessMessage,
  postSreFixFailureMessage: vi.fn(),
  postSreAlreadyFixedMessage: vi.fn(),
  postSreCiRetryMessage: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/githubService', () => ({ GitHubService: { forSystem: vi.fn() } }));

import handler from '../workflow-callback';

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

async function callback(bearer: string) {
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
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
  return res;
}

describe('POST /api/sre/workflow-callback with a token stored under the previous encryption key', () => {
  let previousKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    previousKey = generateEncryptionKey();
    mocks.config.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    mocks.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(mocks.config.SECRET_ENCRYPTION_KEY, mocks.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    mocks.storedToken = encryptSecret(TOKEN, previousKey);
    mocks.getSettingsValue.mockResolvedValue({});
    mocks.findFullById.mockResolvedValue({ repoSlug: REPO, affectedUserIds: ['user-1'] });
    mocks.atomicTransition.mockResolvedValue({ errorMessage: 'TypeError: boom', affectedUserIds: ['user-1'] });
    mocks.postSreFixSuccessMessage.mockResolvedValue(undefined);
  });

  it('accepts the bearer token that matches the decrypted callback token', async () => {
    const res = await callback(TOKEN);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.atomicTransition).toHaveBeenCalledWith('track-1', REPO, 'fixing', 'fixed', expect.any(Object));
  });

  it('rejects a bearer token that does not match', async () => {
    const res = await callback('another-token-fixture');

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.atomicTransition).not.toHaveBeenCalled();
  });

  it('answers with a configuration error when the token was stored under neither key', async () => {
    mocks.storedToken = encryptSecret(TOKEN, generateEncryptionKey());

    const res = await callback(TOKEN);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mocks.atomicTransition).not.toHaveBeenCalled();
  });
});
