import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processQuickAskInDM: vi.fn(),
  findByIdWithCredentials: vi.fn(),
  decryptToken: vi.fn(),
  logger: { updateMetadata: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ processQuickAskInDM: mocks.processQuickAskInDM }));
vi.mock('@bike4mind/database', () => ({
  slackDevWorkspaceRepository: { findByIdWithCredentials: mocks.findByIdWithCredentials },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: mocks.decryptToken }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  SlackEvents: { QuickAskRequested: { schema: { parse: (value: unknown) => value } } },
}));
import { handler } from './slackQuickAsk';

const properties = { slackUserId: 'U1', b4mUserId: 'user1', question: 'hi', workspaceId: 'ws1' };

async function run() {
  const callback = handler as unknown as (event: unknown, logger: typeof mocks.logger) => Promise<void>;
  await callback({ properties }, mocks.logger);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdWithCredentials.mockResolvedValue({ slackBotToken: 'enc' });
  mocks.decryptToken.mockReturnValue('xoxb-1');
});

it('runs the quick ask with the decrypted bot token', async () => {
  await run();
  expect(mocks.decryptToken).toHaveBeenCalledWith('enc');
  expect(mocks.processQuickAskInDM).toHaveBeenCalledWith('U1', 'user1', 'hi', 'xoxb-1', 'ws1');
});

it.each([
  ['workspace is missing', () => mocks.findByIdWithCredentials.mockResolvedValue(null)],
  ['bot token is missing', () => mocks.findByIdWithCredentials.mockResolvedValue({})],
])('logs an error and does nothing when %s', async (_name, arrange) => {
  arrange();
  await run();
  expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
  expect(mocks.logger.error).toHaveBeenCalled();
});

it.each([
  [
    'token decryption',
    () =>
      mocks.decryptToken.mockImplementation(() => {
        throw new Error('boom');
      }),
  ],
  ['the quick ask', () => mocks.processQuickAskInDM.mockRejectedValue(new Error('boom'))],
])('propagates a %s failure so the event dead-letters', async (_name, arrange) => {
  arrange();
  await expect(run()).rejects.toThrow('boom');
  expect(mocks.logger.error).not.toHaveBeenCalled();
});
