import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  configureSlackPackage,
  getSlackDeps,
  handleQuickAskSubmission,
  type ISlackServerDependencies,
  type ISlackDatabaseDependencies,
  type ShortcutViewSubmissionPayload,
} from '@bike4mind/slack';

const hostedSend = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = hostedSend;
  },
  PutEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('sst', () => ({ Resource: { App: { name: 'local-test' }, AppEventBus: { name: 'local-events' } } }));
vi.mock('../../utils/sqs', () => ({ sendToQueue: enqueue }));
import { slackEventPublisher } from './slackEventPublisher';

const detail = { slackUserId: 'U1', b4mUserId: 'user1', question: 'test question', workspaceId: 'ws1' };
const payload: ShortcutViewSubmissionPayload = {
  type: 'view_submission',
  user: { id: 'U1' },
  view: {
    id: 'view1',
    callback_id: 'quick_ask_modal',
    private_metadata: JSON.stringify({ userId: 'user1', workspaceId: 'ws1' }),
    state: { values: { question_block: { question_input: { value: 'test question' } } } },
  },
};
beforeEach(() => {
  vi.stubEnv('B4M_SELF_HOST', 'false');
  hostedSend.mockReset();
  enqueue.mockReset();
  // Exercise the same publisher object bound by initializeSlackPackage; unrelated DI capabilities are unused.
  configureSlackPackage(
    { eventBus: slackEventPublisher } as unknown as ISlackServerDependencies,
    {} as ISlackDatabaseDependencies
  );
});
afterEach(() => vi.unstubAllEnvs());

it.each([{ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] }, { Entries: [{ EventId: 'event-1' }] }])(
  'accepts an acknowledged hosted entry %#',
  async response => {
    hostedSend.mockResolvedValue(response);
    await expect(slackEventPublisher.SlackEvents.QuickAskRequested.publish(detail)).resolves.toBeUndefined();
    expect(hostedSend).toHaveBeenCalledTimes(1);
  }
);

it.each([
  undefined,
  null,
  {},
  { FailedEntryCount: 0, Entries: [] },
  { FailedEntryCount: 0, Entries: [{}] },
  { FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] },
  { FailedEntryCount: 1, Entries: [{ EventId: 'ambiguous' }] },
  { FailedEntryCount: 0, Entries: [{ EventId: 'ambiguous', ErrorCode: 'InternalFailure' }] },
  { FailedEntryCount: 0, Entries: [{ EventId: 'first' }, { EventId: 'second' }] },
])('rejects a fulfilled but failed or ambiguous hosted entry %#', async response => {
  hostedSend.mockResolvedValue(response);
  await expect(slackEventPublisher.SlackEvents.QuickAskRequested.publish(detail)).rejects.toThrow('not accepted');
  expect(hostedSend).toHaveBeenCalledTimes(1);
});

it('actual DI binding returns the modal validation error for HTTP 200 FailedEntryCount 1', async () => {
  hostedSend.mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
  expect(getSlackDeps().eventBus.SlackEvents.QuickAskRequested).toBe(slackEventPublisher.SlackEvents.QuickAskRequested);
  await expect(handleQuickAskSubmission(payload, 'local-fake-token')).resolves.toEqual({
    response_action: 'errors',
    errors: { question_block: 'Failed to submit your question. Please try again.' },
  });
  expect(hostedSend).toHaveBeenCalledTimes(1);
});

it('actual DI binding closes the modal only after the hosted entry is accepted', async () => {
  hostedSend.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
  await expect(handleQuickAskSubmission(payload, 'local-fake-token')).resolves.toEqual({});
  expect(hostedSend).toHaveBeenCalledTimes(1);
});

it('propagates an SDK rejection without an extra publisher retry', async () => {
  hostedSend.mockRejectedValue(new Error('SDK unavailable'));
  await expect(slackEventPublisher.SlackEvents.QuickAskRequested.publish(detail)).rejects.toThrow('SDK unavailable');
  expect(hostedSend).toHaveBeenCalledTimes(1);
});

it('keeps the explicit self-host gap visible instead of enqueueing to an unsupported consumer', async () => {
  vi.stubEnv('B4M_SELF_HOST', 'true');
  await expect(slackEventPublisher.SlackEvents.QuickAskRequested.publish(detail)).rejects.toThrow(
    'hosted event worker'
  );
  expect(hostedSend).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
