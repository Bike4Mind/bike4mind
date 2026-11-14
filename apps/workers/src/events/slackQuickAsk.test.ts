import { createHash } from 'node:crypto';
import type { EventBridgeEvent } from 'aws-lambda';
import { beforeEach, expect, it, vi } from 'vitest';
import { QUICK_ASK_CLAIM_TTL_MS } from './slackQuickAskAdmission';

const mocks = vi.hoisted(() => ({
  processQuickAskInDM: vi.fn(),
  findByIdWithCredentials: vi.fn(),
  incrementCounterConditional: vi.fn(),
  decryptToken: vi.fn(),
  logger: { updateMetadata: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('@workers/utils/eventContext', () => ({
  // Preserve the real wrapper's raw-envelope -> detail translation, not an identity callback.
  withEventContext:
    (callback: (event: { event: string; properties: unknown }, logger: typeof mocks.logger) => Promise<void>) =>
    async (raw: EventBridgeEvent<string, unknown>) => {
      await callback({ event: raw['detail-type'], properties: raw.detail }, mocks.logger);
    },
}));
vi.mock('@bike4mind/server-utils/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ processQuickAskInDM: mocks.processQuickAskInDM }));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { incrementCounterConditional: mocks.incrementCounterConditional },
  slackDevWorkspaceRepository: { findByIdWithCredentials: mocks.findByIdWithCredentials },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: mocks.decryptToken }));
vi.mock('@bike4mind/server-utils/utils/eventBus', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/eventBus')>();
  // Exercise production Zod, including optional identity fields; never replace parse with identity.
  return { SlackEvents: { QuickAskRequested: { schema: actual.SlackEvents.QuickAskRequested.schema } } };
});
import { handler } from './slackQuickAsk';

type RawEvent = EventBridgeEvent<string, unknown>;
const properties = { slackUserId: 'U1', b4mUserId: 'user1', question: 'hi', workspaceId: 'WORKSPACE_ALIAS' };
const envelope = (overrides: Partial<RawEvent> = {}): RawEvent => ({
  version: '0',
  id: 'event-one',
  'detail-type': 'slack.quickAsk.requested',
  source: 'bike4mind',
  account: 'local-test',
  region: 'local',
  resources: [],
  time: new Date().toISOString(),
  detail: properties,
  ...overrides,
});
const claimKey = (workspaceId: string, kind: 'event' | 'request', id: string) =>
  `slack-quick-ask:admission:${createHash('sha256')
    .update(JSON.stringify([workspaceId, kind, id]))
    .digest('hex')}`;
const run = (overrides: Partial<RawEvent> = {}) => handler(envelope(overrides));
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred');
  };
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findByIdWithCredentials.mockResolvedValue({ id: 'canonical-workspace', slackBotToken: 'enc' });
  mocks.decryptToken.mockReturnValue('xoxb-1');
  mocks.incrementCounterConditional.mockResolvedValue({ success: true, count: 1 });
  mocks.processQuickAskInDM.mockResolvedValue(undefined);
});

it('claims the raw delivery using canonical workspace ID before processing with the decrypted token', async () => {
  await run();
  expect(mocks.decryptToken).toHaveBeenCalledWith('enc');
  expect(mocks.incrementCounterConditional).toHaveBeenCalledExactlyOnceWith(
    claimKey('canonical-workspace', 'event', 'event-one'),
    1,
    QUICK_ASK_CLAIM_TTL_MS
  );
  expect(mocks.processQuickAskInDM).toHaveBeenCalledExactlyOnceWith(
    'U1',
    'user1',
    'hi',
    'xoxb-1',
    'canonical-workspace'
  );
  expect(mocks.incrementCounterConditional.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.processQuickAskInDM.mock.invocationCallOrder[0]!
  );
});

it.each([
  ['workspace is missing', () => mocks.findByIdWithCredentials.mockResolvedValue(null)],
  ['bot token is missing', () => mocks.findByIdWithCredentials.mockResolvedValue({ id: 'canonical-workspace' })],
])('logs an error and does nothing when %s', async (_name, arrange) => {
  arrange();
  await run();
  expect(mocks.incrementCounterConditional).not.toHaveBeenCalled();
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
])('propagates a %s failure instead of consuming it', async (_name, arrange) => {
  arrange();
  await expect(run()).rejects.toThrow('boom');
  expect(mocks.logger.error).not.toHaveBeenCalled();
  if (_name === 'token decryption') {
    expect(mocks.incrementCounterConditional).not.toHaveBeenCalled();
    expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
  } else {
    expect(mocks.incrementCounterConditional).toHaveBeenCalledTimes(1);
    expect(mocks.processQuickAskInDM).toHaveBeenCalledTimes(1);
  }
});

it('returns before any Slack or paid processor work when the claim is already consumed', async () => {
  mocks.incrementCounterConditional.mockResolvedValue({ success: false, count: 1 });
  await run();
  expect(mocks.incrementCounterConditional).toHaveBeenCalledTimes(1);
  expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
});

it('fails closed when atomic claim persistence fails', async () => {
  mocks.incrementCounterConditional.mockRejectedValue(new Error('claim unavailable'));
  await expect(run()).rejects.toThrow('claim unavailable');
  expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
});

it('awaits the claim before the first processor side effect', async () => {
  const claim = deferred<{ success: boolean; count: number }>();
  mocks.incrementCounterConditional.mockReturnValue(claim.promise);
  const processing = run();
  try {
    await vi.waitFor(() => expect(mocks.incrementCounterConditional).toHaveBeenCalledTimes(1));
    expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
  } finally {
    claim.resolve({ success: true, count: 1 });
    await processing;
  }
  expect(mocks.processQuickAskInDM).toHaveBeenCalledTimes(1);
});

it.each([
  ['missing envelope ID', () => ({ id: undefined })],
  ['missing envelope time', () => ({ time: undefined })],
  ['malformed envelope time', () => ({ time: 'invalid' })],
  ['older than 30 hours', () => ({ time: new Date(Date.now() - 30 * 60 * 60 * 1_000 - 60_000).toISOString() })],
  ['too far in the future', () => ({ time: new Date(Date.now() + 6 * 60 * 1_000).toISOString() })],
] as const)('refuses %s without persisting a claim or doing paid work', async (_name, overrides) => {
  // Malformed external transport input intentionally crosses the typed AWS boundary.
  const raw = { ...envelope(), ...overrides() } as unknown as RawEvent;
  await expect(handler(raw)).rejects.toThrow();
  expect(mocks.incrementCounterConditional).not.toHaveBeenCalled();
  expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
});

it.each([
  { ...properties, question: 42 },
  { ...properties, requestId: 42 },
  { ...properties, requestId: 'modal-one' },
  { ...properties, requestedAt: new Date().toISOString() },
])('rejects malformed detail or incomplete request identity before admission', async detail => {
  await expect(run({ detail })).rejects.toThrow();
  expect(mocks.incrementCounterConditional).not.toHaveBeenCalled();
  expect(mocks.processQuickAskInDM).not.toHaveBeenCalled();
});

it('prefers the stable request pair for new detail while old detail uses envelope identity', async () => {
  await run({ detail: { ...properties, requestId: 'modal-one', requestedAt: new Date().toISOString() } });
  expect(mocks.incrementCounterConditional).toHaveBeenCalledExactlyOnceWith(
    claimKey('canonical-workspace', 'request', 'modal-one'),
    1,
    QUICK_ASK_CLAIM_TTL_MS
  );
});

it('keeps raw envelopes invocation-local when credential requests complete in reverse order', async () => {
  type Workspace = { id: string; slackBotToken: string };
  const firstCredentials = deferred<Workspace>();
  const secondCredentials = deferred<Workspace>();
  mocks.findByIdWithCredentials
    .mockReturnValueOnce(firstCredentials.promise)
    .mockReturnValueOnce(secondCredentials.promise);
  mocks.decryptToken.mockImplementation((token: string) => `decrypted-${token}`);
  const first = run({ id: 'event-A', detail: { ...properties, workspaceId: 'ALIAS_A', question: 'question-A' } });
  const second = run({ id: 'event-B', detail: { ...properties, workspaceId: 'ALIAS_B', question: 'question-B' } });
  try {
    secondCredentials.resolve({ id: 'canonical-B', slackBotToken: 'token-B' });
    await second;
    expect(mocks.processQuickAskInDM).toHaveBeenCalledExactlyOnceWith(
      'U1',
      'user1',
      'question-B',
      'decrypted-token-B',
      'canonical-B'
    );
    expect(mocks.incrementCounterConditional).toHaveBeenNthCalledWith(
      1,
      claimKey('canonical-B', 'event', 'event-B'),
      1,
      QUICK_ASK_CLAIM_TTL_MS
    );
    firstCredentials.resolve({ id: 'canonical-A', slackBotToken: 'token-A' });
    await first;
    expect(mocks.processQuickAskInDM).toHaveBeenNthCalledWith(
      2,
      'U1',
      'user1',
      'question-A',
      'decrypted-token-A',
      'canonical-A'
    );
    expect(mocks.incrementCounterConditional).toHaveBeenNthCalledWith(
      2,
      claimKey('canonical-A', 'event', 'event-A'),
      1,
      QUICK_ASK_CLAIM_TTL_MS
    );
  } finally {
    firstCredentials.resolve({ id: 'canonical-A', slackBotToken: 'token-A' });
    secondCredentials.resolve({ id: 'canonical-B', slackBotToken: 'token-B' });
    await Promise.allSettled([first, second]);
  }
});
