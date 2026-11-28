import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PutEventsCommand, PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import type { SendMessageCommand, SendMessageCommandOutput } from '@aws-sdk/client-sqs';
import mongoose from 'mongoose';
import {
  AgentExecutionModel,
  AssistantBriefModel,
  EMAIL_TRIAGE_KINDS,
  EmailTriageItemModel,
  User,
  agentExecutionRepository,
  assistantBriefRepository,
  emailTriageItemRepository,
  userRepository,
} from '@bike4mind/database';
import {
  startBlockBrief,
  startBriefComposition,
  startScheduledBrief,
  type ScheduledBriefDeps,
} from '@bike4mind/server-utils/briefs/startBriefComposition';
import { BriefComposeRejectedError, publishBriefCompose } from '@bike4mind/server-utils/briefs/publishBriefCompose';
import { BriefEvents } from '@bike4mind/server-utils/utils/eventBus';
import { composeBrief, handler as composeHandler } from '../events/briefCompose';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { RETRY_WINDOW_MS, runBriefScheduleReconcile } from './briefScheduleReconcile';
import { computeNextBriefAt, SCHEDULED_BRIEF_MIN_GAP_MS } from '@bike4mind/server-utils/briefs/briefSchedule';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test', name: 'test' }, AppEventBus: { name: 'test' } } }));
const network = vi.hoisted(() => ({
  events: vi.fn<(command: PutEventsCommand) => Promise<PutEventsCommandOutput>>(),
  queue: vi.fn<(command: SendMessageCommand) => Promise<SendMessageCommandOutput>>(),
}));
vi.mock('@aws-sdk/client-eventbridge', async importOriginal => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-eventbridge')>()),
  EventBridgeClient: class {
    send = network.events;
  },
}));
vi.mock('@aws-sdk/client-sqs', async importOriginal => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-sqs')>()),
  SQSClient: class {
    send = network.queue;
  },
}));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: vi.fn(() => {
      throw new Error('Unexpected model call');
    }),
  },
}));
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Real clock: the composer stamps createdAt itself and its in-flight check compares against it.
const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const schedule = { enabled: true, timeOfDay: '08:00', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'America/Los_Angeles' };
// Next slot is 6-7 days out, so a wake-up asserted against it never loses to the regular slot at any time of day.
const weeklySchedule = { ...schedule, days: [now.getUTCDay()], timeZone: 'UTC', timeOfDay: '00:00' };
let server: Awaited<ReturnType<typeof createMongoServer>>;
const publishCompose = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  publishCompose.mockClear();
  notifyHeldRuns.mockClear();
  notifyStaleBlock.mockClear();
  network.events.mockReset().mockResolvedValue({ $metadata: {}, FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });
  network.queue.mockReset().mockResolvedValue({ $metadata: {}, MessageId: 'm1' });
  vi.stubEnv('B4M_SELF_HOST', 'false');
  await Promise.all([
    User.collection.deleteMany({}),
    AssistantBriefModel.collection.deleteMany({}),
    AgentExecutionModel.collection.deleteMany({}),
    EmailTriageItemModel.collection.deleteMany({}),
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const insertUser = async (fields: Record<string, unknown>) =>
  (await User.collection.insertOne({ username: 'u', email: 'u@example.com', ...fields })).insertedId.toString();
const insertRun = (userId: string) =>
  AgentExecutionModel.collection.insertOne({
    userId,
    sessionId: 's1',
    query: 'q',
    status: 'completed',
    createdAt: minutesAgo(60),
  });
const nextBriefAtOf = async (userId: string) => (await userRepository.getBriefSchedule(userId)).nextBriefAt;

const notifyHeldRuns = vi.fn(async (_userId: string, _block: { start: Date; end: Date }) => {});
const notifyStaleBlock = vi.fn(async (_userId: string, _block: { start: Date; end: Date }) => {});

const run = (publisher: ScheduledBriefDeps['publishCompose'] = publishCompose, at = now) =>
  runBriefScheduleReconcile(
    {
      users: userRepository,
      reminders: assistantBriefRepository,
      startScheduledBrief: userId =>
        startScheduledBrief(userId, {
          briefs: assistantBriefRepository,
          runs: agentExecutionRepository,
          users: userRepository,
          hasRunsSince: async (id, since) =>
            (await agentExecutionRepository.findByUserIdPaginated(id, { fromDate: since }, { limit: 1 })).items.length >
            0,
          hasDueReminders: async (id, now) => (await assistantBriefRepository.findDueReminders(id, now, 1)).length > 0,
          hasPendingEmails: async (id, end) =>
            (
              await Promise.all(EMAIL_TRIAGE_KINDS.map(kind => emailTriageItemRepository.listPending(id, end, 1, kind)))
            ).some(items => items.length > 0),
          publishCompose: publisher,
          now: () => new Date(),
        }),
      startBlockBrief: (userId, block) =>
        startBlockBrief(userId, block, {
          briefs: assistantBriefRepository,
          runs: agentExecutionRepository,
          users: userRepository,
          hasRunsBetween: async (id, start, end) =>
            (await agentExecutionRepository.findByUserIdPaginated(id, { fromDate: start, toDate: end }, { limit: 1 }))
              .items.length > 0,
          hasEmailsBetween: async (id, start, end) =>
            (
              await Promise.all(
                EMAIL_TRIAGE_KINDS.map(kind => emailTriageItemRepository.listPending(id, end, 1, kind, start))
              )
            ).some(items => items.length > 0),
          notifyHeldRuns,
          publishCompose: publisher,
          now: () => new Date(),
        }),
      notifyHeldBlockRuns: notifyStaleBlock,
      outOfTime: () => false,
    },
    at
  );

describe('runBriefScheduleReconcile', () => {
  it('starts one brief for a due user with activity across two concurrent runs, and advances the slot', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    await insertRun(userId);

    const [a, b] = await Promise.all([run(), run()]);

    expect(a.enqueued + b.enqueued).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
    expect(publishCompose).toHaveBeenCalledTimes(1);
    expect(publishCompose).toHaveBeenCalledWith(expect.objectContaining({ userId, scheduled: true }));
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('writes no row for a due user with no activity but still advances the slot', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });

    expect((await run()).no_activity).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('skips a due user with brief pushes off', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: schedule, pushNotifications: { brief_ready: false } },
      nextBriefAt: minutesAgo(2),
    });
    await insertRun(userId);

    expect((await run()).push_off).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
  });

  it('still starts the slot when an event brief started earlier inside the event gap', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: schedule },
      nextBriefAt: minutesAgo(2),
      lastBriefStartedAt: minutesAgo(30),
    });
    await insertRun(userId);

    const result = await run();
    expect(result.enqueued).toBe(1);
    expect(result.debounced).toBe(0);
    expect(publishCompose).toHaveBeenCalledTimes(1);
  });

  it('counts a due user whose racing brief start just claimed as debounced and still advances the slot', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: schedule },
      nextBriefAt: minutesAgo(2),
      lastBriefStartedAt: minutesAgo(5),
    });
    await insertRun(userId);

    const result = await run();
    expect(result.debounced).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  const insertApprovedReminder = async (userId: string, remindAt: Date) => {
    const brief = await assistantBriefRepository.createComposing({
      userId,
      periodStart: now,
      periodEnd: now,
      origin: 'followUp',
      followUpInput: { transcript: 'memo' },
    });
    await assistantBriefRepository.markReady(
      String(brief._id),
      {
        headline: 'Follow-ups',
        happened: [],
        handled: [],
        decisions: [
          { id: 'fu-reminder-1', text: 'Remind me: call', followUp: { kind: 'reminder', state: 'approved', remindAt } },
        ],
      },
      now
    );
  };

  it('re-arms a fired slot at the next approved reminder when it comes before the regular slot', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    const regular = computeNextBriefAt(schedule, now)!;
    const later = new Date(now.getTime() + Math.floor((regular.getTime() - now.getTime()) / 2));
    await insertApprovedReminder(userId, later);

    await run();
    expect(await nextBriefAtOf(userId)).toEqual(later);
  });

  it('keeps a future reminder approved between the reminder read and slot advance', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: weeklySchedule }, nextBriefAt: minutesAgo(2) });
    const reminderAt = new Date(now.getTime() + 5 * 60_000);
    const read = assistantBriefRepository.findEarliestPendingReminderAt.bind(assistantBriefRepository);
    vi.spyOn(assistantBriefRepository, 'findEarliestPendingReminderAt').mockImplementationOnce(async (...args) => {
      const stale = await read(...args);
      await insertApprovedReminder(userId, reminderAt);
      await userRepository.pullNextBriefAtForward(userId, reminderAt);
      return stale;
    });
    expect((await run()).no_activity).toBe(1);
    expect(await nextBriefAtOf(userId)).toEqual(reminderAt);
  });

  it('re-arms an accepted slot while an overdue reminder remains unlisted', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: weeklySchedule }, nextBriefAt: minutesAgo(2) });
    await insertApprovedReminder(userId, minutesAgo(1));
    expect((await run()).enqueued).toBe(1);
    expect(await nextBriefAtOf(userId)).toEqual(new Date(now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS));
  });

  it('surfaces thirteen due reminders in two capped real compositions before the weekly slot', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const userId = await insertUser({ preferences: { briefSchedule: weeklySchedule }, nextBriefAt: minutesAgo(2) });
      for (let index = 0; index < 13; index++) await insertApprovedReminder(userId, minutesAgo(index + 1));
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
      const composePublished = async () => {
        const event = publishCompose.mock.lastCall?.[0];
        expect(event).toMatchObject({ userId, scheduled: true });
        await (composeHandler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
          { properties: event },
          logger
        );
      };
      expect((await run()).enqueued).toBe(1);
      await composePublished();
      expect(await assistantBriefRepository.findDueReminders(userId, now, 20)).toHaveLength(1);
      const retryAt = new Date(now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS);
      expect(await nextBriefAtOf(userId)).toEqual(retryAt);
      vi.setSystemTime(retryAt);
      expect((await run(publishCompose, retryAt)).enqueued).toBe(1);
      await composePublished();
      expect(await assistantBriefRepository.findDueReminders(userId, retryAt, 20)).toHaveLength(0);
      const ready = await AssistantBriefModel.find({ userId, origin: { $ne: 'followUp' }, status: 'ready' }).sort({
        createdAt: 1,
      });
      expect(ready.map(brief => brief.happened.length)).toEqual([12, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restore a due time when the schedule is disabled during post-claim reconciliation', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    await insertApprovedReminder(userId, minutesAgo(1));
    const read = assistantBriefRepository.findEarliestPendingReminderAt.bind(assistantBriefRepository);
    vi.spyOn(assistantBriefRepository, 'findEarliestPendingReminderAt').mockImplementation(async (...args) => {
      const reminder = await read(...args);
      if (!args[1]) await userRepository.setBriefSchedule(userId, { ...schedule, enabled: false }, null);
      return reminder;
    });
    expect((await run()).enqueued).toBe(1);
    expect(await nextBriefAtOf(userId)).toBeNull();
    expect((await userRepository.getBriefSchedule(userId)).schedule?.enabled).toBe(false);
  });

  it.each([false, true])('retains accepted work after reminder read failure with disabled=%s', async disabled => {
    const userId = await insertUser({ preferences: { briefSchedule: weeklySchedule }, nextBriefAt: minutesAgo(2) });
    await insertApprovedReminder(userId, minutesAgo(1));
    const read = assistantBriefRepository.findEarliestPendingReminderAt.bind(assistantBriefRepository);
    vi.spyOn(assistantBriefRepository, 'findEarliestPendingReminderAt').mockImplementation(async (...args) => {
      if (!args[1]) {
        if (disabled) await userRepository.setBriefSchedule(userId, { ...weeklySchedule, enabled: false }, null);
        throw new Error('reminder lookup unavailable');
      }
      return read(...args);
    });
    const result = await run();
    expect(result.enqueued).toBe(1);
    expect(result.failed).toBe(0);
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'composing' })).toBe(1);
    expect(await nextBriefAtOf(userId)).toEqual(disabled ? null : new Date(now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS));
    expect(publishCompose).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm overdue reminders while brief pushes are off', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: schedule, pushNotifications: { brief_ready: false } },
      nextBriefAt: minutesAgo(2),
    });
    await insertApprovedReminder(userId, minutesAgo(1));
    expect((await run()).push_off).toBe(1);
    expect(await nextBriefAtOf(userId)).toEqual(computeNextBriefAt(schedule, now));
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'composing' })).toBe(0);
  });

  it('retries a debounced slot after the gap when a reminder is already due', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: schedule },
      nextBriefAt: minutesAgo(2),
      lastBriefStartedAt: minutesAgo(5),
    });
    await insertApprovedReminder(userId, minutesAgo(1));

    const result = await run();
    expect(result.debounced).toBe(1);
    const regular = computeNextBriefAt(schedule, now)!.getTime();
    expect(await nextBriefAtOf(userId)).toEqual(
      new Date(Math.min(regular, now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS))
    );
  });

  it('retries an in-flight slot after the gap when a reminder is already due', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    await insertApprovedReminder(userId, minutesAgo(1));
    await assistantBriefRepository.createComposing({ userId, periodStart: now, periodEnd: now });

    const result = await run();
    expect(result.in_flight).toBe(1);
    const regular = computeNextBriefAt(schedule, now)!.getTime();
    expect(await nextBriefAtOf(userId)).toEqual(
      new Date(Math.min(regular, now.getTime() + SCHEDULED_BRIEF_MIN_GAP_MS))
    );
  });

  it('leaves a user whose slot is still ahead untouched', async () => {
    const future = new Date(now.getTime() + 60 * 60_000);
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: future });
    await insertRun(userId);

    expect((await run()).due).toBe(0);
    expect(await nextBriefAtOf(userId)).toEqual(future);
  });

  it('clears the due time of a disabled schedule without starting a brief', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: { ...schedule, enabled: false } },
      nextBriefAt: minutesAgo(2),
    });

    expect((await run()).unscheduled).toBe(1);
    expect(await nextBriefAtOf(userId)).toBeNull();
    expect(publishCompose).not.toHaveBeenCalled();
  });

  it('hands a slot back when the start throws, so the next run starts it', async () => {
    const due = minutesAgo(2);
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: due });
    await insertRun(userId);
    publishCompose.mockRejectedValueOnce(new BriefComposeRejectedError());

    expect((await run()).failed).toBe(1);
    expect(await nextBriefAtOf(userId)).toEqual(due);

    // The failed attempt leaves no composing row behind to read as in flight, so the very next run starts it.
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    const retried = await run();
    expect(retried.enqueued).toBe(1);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it.each(['missing_queue', 'failed_entry'] as const)(
    'retries definitive %s rejection through the actual event publisher',
    async failure => {
      const due = minutesAgo(2);
      const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: due });
      await insertRun(userId);
      if (failure === 'missing_queue') {
        vi.stubEnv('B4M_SELF_HOST', 'true');
        vi.stubEnv('SELF_HOST_EVENT_QUEUE', undefined);
      } else {
        network.events.mockResolvedValueOnce({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: 'InternalFailure' }],
        });
      }
      expect((await run(publishBriefCompose)).failed).toBe(1);
      expect(await nextBriefAtOf(userId)).toEqual(due);
      expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
      if (failure === 'missing_queue') {
        expect(network.queue).not.toHaveBeenCalled();
        vi.stubEnv('SELF_HOST_EVENT_QUEUE', 'https://queue.example.test/events');
      }
      expect((await run(publishBriefCompose)).enqueued).toBe(1);
      expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
      expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
      const sent =
        failure === 'missing_queue'
          ? network.queue.mock.calls[0][0].input.MessageBody
          : network.events.mock.calls[1][0].input.Entries?.[0].Detail;
      expect(sent).toContain(userId);
    }
  );

  it('retains a slot and row when the configured self-host queue throws with unknown acceptance', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    await insertRun(userId);
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('SELF_HOST_EVENT_QUEUE', 'https://queue.example.test/events');
    network.queue.mockRejectedValueOnce(new Error('response unavailable'));
    expect((await run(publishBriefCompose)).failed).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'composing' })).toBe(1);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
    expect((await run(publishBriefCompose)).due).toBe(0);
    expect(network.queue).toHaveBeenCalledTimes(1);
  });

  it('preserves accepted work through a lost response and an immediate manual retry', async () => {
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: minutesAgo(2) });
    await insertRun(userId);
    let releaseModel: (reply: string) => void = () => {
      throw new Error('model was not started');
    };
    const reply = new Promise<string>(resolve => {
      releaseModel = resolve;
    });
    let modelStarted: () => void = () => {
      throw new Error('model latch missing');
    };
    const started = new Promise<void>(resolve => {
      modelStarted = resolve;
    });
    const complete = vi.fn(async () => {
      modelStarted();
      return reply;
    });
    const push = vi.fn().mockResolvedValue(undefined);
    let worker: Promise<void> | undefined;
    network.events.mockImplementationOnce(async command => {
      const event = BriefEvents.Compose.schema.parse(JSON.parse(command.input.Entries![0].Detail!));
      worker = composeBrief(
        {
          now: () => new Date(),
          users: userRepository,
          briefs: assistantBriefRepository,
          emails: emailTriageItemRepository,
          delegations: { markBriefed: async () => 0 },
          loadActivity: async brief => ({
            periodStart: brief.periodStart,
            periodEnd: brief.periodEnd,
            runs: [{ id: 'r1', query: 'q', status: 'completed', finishedAt: undefined, errorMessage: undefined }],
            approvals: [],
            questions: [],
            emails: [],
            delegations: [],
            reminders: [],
            obligations: [],
          }),
          canCompose: async () => 'ok',
          loadInstructions: async () => [],
          complete,
          push,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        event
      );
      await Promise.race([
        started,
        worker.then(() => {
          throw new Error('composer settled before reaching the model');
        }),
      ]);
      throw new Error('accepted event response lost');
    });
    try {
      expect((await run(publishBriefCompose)).failed).toBe(1);
      const retained = await AssistantBriefModel.findOne({ userId, status: 'composing' });
      expect(retained).not.toBeNull();
      expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
      const retried = await startBriefComposition(userId);
      expect(retried._id.toString()).toBe(retained!._id.toString());
      expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
      expect(network.events).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      releaseModel(JSON.stringify({ headline: 'Done.', handled: ['Handled the run.'] }));
      await worker;
    }
    expect(await AssistantBriefModel.countDocuments({ userId, status: 'ready' })).toBe(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('keeps the advanced slot when a start throws past the retry window', async () => {
    const due = new Date(now.getTime() - RETRY_WINDOW_MS - 60_000);
    const userId = await insertUser({ preferences: { briefSchedule: schedule }, nextBriefAt: due });

    const result = await runBriefScheduleReconcile(
      {
        users: userRepository,
        reminders: assistantBriefRepository,
        startScheduledBrief: async () => {
          throw new Error('event bus unavailable');
        },
        outOfTime: () => false,
      },
      now
    );

    expect(result.failed).toBe(1);
    expect((await nextBriefAtOf(userId))!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('clears the due time of a stored schedule whose zone cannot be computed, so it stops blocking the batch', async () => {
    const userId = await insertUser({
      preferences: { briefSchedule: { ...schedule, timeZone: 'Not/AZone' } },
      nextBriefAt: minutesAgo(2),
    });

    expect((await run()).failed).toBe(1);
    expect(await nextBriefAtOf(userId)).toBeNull();
    expect((await run()).due).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
  });
});

describe('runBriefScheduleReconcile block briefs', () => {
  const block = { start: minutesAgo(40), end: minutesAgo(10) };
  const later = { start: now.getTime() + 60 * 60_000, end: now.getTime() + 90 * 60_000 };
  const laterBlock = { start: new Date(later.start), end: new Date(later.end) };
  const insertBlockUser = (preferences: object = { busyBlockBrief: { enabled: true } }) =>
    insertUser({ preferences, busyBlocks: [block, laterBlock], nextBlockBriefAt: block.end });
  const insertEmail = (userId: string, emailId: string, createdAt: Date) =>
    EmailTriageItemModel.collection.insertOne({
      userId,
      emailId,
      kind: EMAIL_TRIAGE_KINDS[0],
      summary: 's',
      briefedAt: null,
      createdAt,
    });
  const blockState = async (userId: string) => {
    const doc = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    return { next: doc?.nextBlockBriefAt ?? null, last: doc?.lastBlockBriefEnd ?? null };
  };

  it('starts one brief with the block bounds across two concurrent runs, then moves to the next block', async () => {
    const userId = await insertBlockUser();
    await insertEmail(userId, 'before', minutesAgo(60));
    await insertEmail(userId, 'inside', minutesAgo(20));

    const [a, b] = await Promise.all([run(), run()]);

    expect(a.blocks.enqueued + b.blocks.enqueued).toBe(1);
    expect(a.blocks.claimedElsewhere + b.blocks.claimedElsewhere).toBe(1);
    const briefs = await AssistantBriefModel.find({ userId }).lean();
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ trigger: 'busy_block', busyBlock: block });
    expect(publishCompose).toHaveBeenCalledTimes(1);
    expect(await blockState(userId)).toEqual({ next: laterBlock.end, last: block.end });

    const again = await run();
    expect(again.blocks.due).toBe(0);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
  });

  it('writes no row when nothing arrived during the block, and still claims it', async () => {
    const userId = await insertBlockUser();
    await insertEmail(userId, 'before', minutesAgo(60));

    expect((await run()).blocks.no_activity).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(publishCompose).not.toHaveBeenCalled();
    expect(await blockState(userId)).toEqual({ next: laterBlock.end, last: block.end });
    expect(notifyHeldRuns).toHaveBeenCalledWith(userId, block);
  });

  it('claims without starting when the opt-in was turned off', async () => {
    const userId = await insertBlockUser({ busyBlockBrief: { enabled: false } });
    await insertEmail(userId, 'inside', minutesAgo(20));

    expect((await run()).blocks.busy_off).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(notifyHeldRuns).not.toHaveBeenCalled();
  });

  it('does not re-arm a claimed block when the calendar re-syncs it', async () => {
    const userId = await insertBlockUser();
    await insertEmail(userId, 'inside', minutesAgo(20));
    await run();

    const state = await userRepository.setBusyBlocks(userId, { enabled: true, blocks: [block, laterBlock] }, now);

    expect(state.nextBlockBriefAt).toEqual(laterBlock.end);
    expect((await run()).blocks.due).toBe(0);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(1);
  });

  it('hands a block back when the start throws, so the next run starts it', async () => {
    const userId = await insertBlockUser();
    await insertEmail(userId, 'inside', minutesAgo(20));

    publishCompose.mockRejectedValueOnce(new BriefComposeRejectedError());

    expect((await run()).blocks.failed).toBe(1);
    expect(await blockState(userId)).toEqual({ next: block.end, last: null });
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);

    expect((await run()).blocks.enqueued).toBe(1);
  });

  it('hands a block back when another brief is composing, so a later run starts it', async () => {
    const userId = await insertBlockUser();
    await insertEmail(userId, 'inside', minutesAgo(20));
    const composing = await assistantBriefRepository.createComposing({ userId, periodStart: now, periodEnd: now });

    expect((await run()).blocks.in_flight).toBe(1);
    expect(await blockState(userId)).toEqual({ next: block.end, last: null });

    await AssistantBriefModel.deleteOne({ _id: composing._id });
    expect((await run()).blocks.enqueued).toBe(1);
    expect(await AssistantBriefModel.findOne({ userId }).lean()).toMatchObject({ busyBlock: block });
  });

  it('claims and drops a block that ended past the retry window', async () => {
    const old = { start: new Date(now.getTime() - RETRY_WINDOW_MS - 30 * 60_000), end: minutesAgo(61) };
    const userId = await insertUser({
      preferences: { busyBlockBrief: { enabled: true } },
      busyBlocks: [old],
      nextBlockBriefAt: old.end,
    });
    await insertEmail(userId, 'inside', minutesAgo(65));

    expect((await run()).blocks.stale).toBe(1);
    expect(await AssistantBriefModel.countDocuments({ userId })).toBe(0);
    expect(await blockState(userId)).toEqual({ next: null, last: old.end });
    expect(notifyStaleBlock).toHaveBeenCalledTimes(1);
    expect(notifyStaleBlock).toHaveBeenCalledWith(userId, old);
    expect(notifyHeldRuns).not.toHaveBeenCalled();
  });

  it('counts a due end with no stored block as unscheduled', async () => {
    const userId = await insertUser({
      preferences: { busyBlockBrief: { enabled: true } },
      busyBlocks: [laterBlock],
      nextBlockBriefAt: block.end,
    });

    expect((await run()).blocks.unscheduled).toBe(1);
    expect(await blockState(userId)).toEqual({ next: laterBlock.end, last: block.end });
  });
});
