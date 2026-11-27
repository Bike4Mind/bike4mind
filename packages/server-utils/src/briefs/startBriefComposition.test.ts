import { describe, expect, it, vi } from 'vitest';
import type { IAssistantBrief } from '@bike4mind/database';
import {
  BriefComposeStartError,
  startBriefComposition,
  startEventBrief,
  startBlockBrief,
  startFollowUpComposition,
  startScheduledBrief,
  type BlockBriefDeps,
  type ScheduledBriefDeps,
} from './startBriefComposition';
import { BRIEF_MIN_GAP_MS, SCHEDULED_BRIEF_MIN_GAP_MS } from './briefSchedule';
import { BriefComposeRejectedError } from './publishBriefCompose';

const now = new Date('2026-11-17T12:00:00Z');
const stored = (overrides: Partial<IAssistantBrief> = {}) =>
  ({
    _id: 'b1',
    userId: 'u1',
    periodStart: new Date('2026-11-16T12:00:00Z'),
    periodEnd: now,
    ...overrides,
  }) as unknown as IAssistantBrief;

const makeDeps = (
  over: { inFlight?: IAssistantBrief | null; latest?: IAssistantBrief | null; straddling?: Date | null } = {}
) => ({
  runs: { findEarliestStraddlingRunCreatedAt: vi.fn().mockResolvedValue(over.straddling ?? null) },
  briefs: {
    findActiveComposing: vi.fn().mockResolvedValue(over.inFlight ?? null),
    findLatestReady: vi.fn().mockResolvedValue(over.latest ?? null),
    createComposing: vi.fn().mockImplementation(async input => stored(input)),
    discardComposing: vi.fn().mockResolvedValue(true),
  },
  publishCompose: vi.fn().mockResolvedValue(undefined),
  now: () => now,
});

describe('startBriefComposition', () => {
  it('returns the in-flight brief without publishing a second compose event', async () => {
    const deps = makeDeps({ inFlight: stored({ status: 'composing' }) });
    const brief = await startBriefComposition('u1', deps);
    expect(brief._id).toBe('b1');
    expect(deps.briefs.createComposing).not.toHaveBeenCalled();
    expect(deps.publishCompose).not.toHaveBeenCalled();
  });

  it('starts from the last ready brief and publishes the compose event', async () => {
    const lastEnd = new Date('2026-11-17T06:00:00Z');
    const deps = makeDeps({ latest: stored({ periodEnd: lastEnd }) });
    await startBriefComposition('u1', deps);
    expect(deps.briefs.createComposing).toHaveBeenCalledWith({ userId: 'u1', periodStart: lastEnd, periodEnd: now });
    expect(deps.publishCompose).toHaveBeenCalledWith({ briefId: 'b1', userId: 'u1' });
  });

  it('drops the created row only after definitive non-acceptance', async () => {
    const deps = makeDeps();
    const cause = new BriefComposeRejectedError();
    deps.publishCompose.mockRejectedValue(cause);
    await expect(startBriefComposition('u1', deps)).rejects.toMatchObject({
      briefId: 'b1',
      retrySafe: true,
      cause,
    });
    expect(deps.briefs.discardComposing).toHaveBeenCalledWith('b1');
  });

  it('retains the row and original error when acceptance is unknown', async () => {
    const deps = makeDeps();
    const cause = new Error('transport timed out');
    deps.publishCompose.mockRejectedValue(cause);
    await expect(startBriefComposition('u1', deps)).rejects.toMatchObject({
      briefId: 'b1',
      retrySafe: false,
      cause,
    });
    expect(deps.briefs.discardComposing).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'])('prevents retry when rejected-row cleanup returns %s', async failure => {
    const deps = makeDeps();
    const cause = new BriefComposeRejectedError();
    deps.publishCompose.mockRejectedValue(cause);
    if (failure === 'false') deps.briefs.discardComposing.mockResolvedValue(false);
    else deps.briefs.discardComposing.mockRejectedValue(new Error('database unavailable'));
    await expect(startBriefComposition('u1', deps)).rejects.toMatchObject({
      name: BriefComposeStartError.name,
      briefId: 'b1',
      retrySafe: false,
      cause,
    });
  });

  it('defaults to the last day with no prior brief and caps a stale one at a week', async () => {
    const first = makeDeps();
    await startBriefComposition('u1', first);
    expect(first.briefs.createComposing.mock.calls[0][0].periodStart).toEqual(new Date('2026-11-16T12:00:00Z'));

    const stale = makeDeps({ latest: stored({ periodEnd: new Date('2026-10-01T00:00:00Z') }) });
    await startBriefComposition('u1', stale);
    expect(stale.briefs.createComposing.mock.calls[0][0].periodStart).toEqual(new Date('2026-11-10T12:00:00Z'));
  });

  it('moves the start back to a run that was still going when the last brief ended', async () => {
    const lastEnd = new Date('2026-11-17T06:00:00Z');
    const runCreated = new Date('2026-11-17T05:00:00Z');
    const deps = makeDeps({ latest: stored({ periodEnd: lastEnd }), straddling: runCreated });
    await startBriefComposition('u1', deps);
    expect(deps.runs.findEarliestStraddlingRunCreatedAt).toHaveBeenCalledWith(
      'u1',
      lastEnd,
      new Date('2026-11-10T12:00:00Z')
    );
    expect(deps.briefs.createComposing).toHaveBeenCalledWith({ userId: 'u1', periodStart: runCreated, periodEnd: now });
  });
});

type GatedOver = {
  hasReminders?: boolean;
  user?: object | null;
  inFlight?: IAssistantBrief | null;
  hasRuns?: boolean;
  claimed?: boolean;
  straddling?: Date | null;
};

describe('startFollowUpComposition', () => {
  it('creates a follow-up row with the memo, never reusing an in-flight brief, and keeps the memo off the event', async () => {
    const deps = makeDeps({ inFlight: stored({ status: 'composing' }) });
    await startFollowUpComposition('u1', { transcript: 'Email Sam', timeZone: 'UTC' }, deps);
    expect(deps.briefs.findActiveComposing).not.toHaveBeenCalled();
    expect(deps.briefs.createComposing).toHaveBeenCalledWith({
      userId: 'u1',
      periodStart: now,
      periodEnd: now,
      origin: 'followUp',
      followUpInput: { transcript: 'Email Sam', timeZone: 'UTC' },
    });
    expect(deps.publishCompose).toHaveBeenCalledWith({ briefId: 'b1', userId: 'u1' });
  });

  it('discards the row when the event is rejected', async () => {
    const deps = makeDeps();
    deps.publishCompose.mockRejectedValue(new BriefComposeRejectedError());
    await expect(startFollowUpComposition('u1', { transcript: 'memo' }, deps)).rejects.toMatchObject({
      name: BriefComposeStartError.name,
      retrySafe: true,
    });
    expect(deps.briefs.discardComposing).toHaveBeenCalledWith('b1');
    expect(deps.briefs.createComposing.mock.calls[0][0].followUpInput).toEqual({ transcript: 'memo' });
  });
});

const PREVIOUS_START = new Date('2026-11-17T01:00:00Z');
const enabledUser = { preferences: { briefSchedule: { enabled: true } } };

const makeGatedDeps = (over: GatedOver = {}) => {
  const base = makeDeps({ inFlight: over.inFlight, straddling: over.straddling });
  return {
    ...base,
    users: {
      findById: vi.fn().mockResolvedValue(over.user === undefined ? enabledUser : over.user),
      claimBriefStart: vi.fn().mockResolvedValue(over.claimed === false ? null : { previous: PREVIOUS_START }),
      releaseBriefStart: vi.fn().mockResolvedValue(true),
    },
    hasRunsSince: vi.fn().mockResolvedValue(over.hasRuns ?? true),
    hasPendingEmails: vi.fn().mockResolvedValue(false),
    hasDueReminders: vi.fn().mockResolvedValue(over.hasReminders ?? false),
  };
};
const asDeps = (deps: ReturnType<typeof makeGatedDeps>) => deps as unknown as ScheduledBriefDeps;

describe.each([
  ['startEventBrief', startEventBrief, BRIEF_MIN_GAP_MS],
  ['startScheduledBrief', startScheduledBrief, SCHEDULED_BRIEF_MIN_GAP_MS],
] as const)('%s', (_name, start, gapMs) => {
  it.each([
    ['user_missing', { user: null }],
    ['schedule_off', { user: { preferences: { briefSchedule: { enabled: false } } } }],
    [
      'push_off',
      { user: { preferences: { briefSchedule: { enabled: true }, pushNotifications: { brief_ready: false } } } },
    ],
    ['in_flight', { inFlight: stored({ status: 'composing' }) }],
    ['no_activity', { hasRuns: false }],
    ['debounced', { claimed: false }],
  ] as const)('returns %s without publishing', async (outcome, over) => {
    const deps = makeGatedDeps(over);
    expect(await start('u1', asDeps(deps))).toBe(outcome);
    expect(deps.publishCompose).not.toHaveBeenCalled();
    expect(deps.briefs.createComposing).not.toHaveBeenCalled();
    expect(deps.users.releaseBriefStart).not.toHaveBeenCalled();
  });

  it('claims its gap at the gate time, then publishes a scheduled compose', async () => {
    const deps = makeGatedDeps();
    expect(await start('u1', asDeps(deps))).toBe('enqueued');
    expect(deps.users.claimBriefStart).toHaveBeenCalledWith('u1', now, gapMs);
    expect(deps.publishCompose).toHaveBeenCalledWith({ briefId: 'b1', userId: 'u1', scheduled: true });
    expect(deps.users.releaseBriefStart).not.toHaveBeenCalled();
  });

  it('gives the claim back when a composition started elsewhere after the in-flight check', async () => {
    const deps = makeGatedDeps();
    deps.briefs.findActiveComposing.mockResolvedValueOnce(null).mockResolvedValueOnce(stored({ status: 'composing' }));
    expect(await start('u1', asDeps(deps))).toBe('in_flight');
    expect(deps.publishCompose).not.toHaveBeenCalled();
    expect(deps.users.releaseBriefStart).toHaveBeenCalledWith('u1', now, PREVIOUS_START);
  });

  it('counts a due reminder as activity when nothing else happened', async () => {
    const deps = makeGatedDeps({ hasRuns: false, hasReminders: true });
    expect(await start('u1', asDeps(deps))).toBe('enqueued');
    expect(deps.hasDueReminders).toHaveBeenCalledWith('u1', now);
  });

  it('counts a run that finished after the last brief as activity', async () => {
    const runCreated = new Date('2026-11-17T05:00:00Z');
    const deps = makeGatedDeps({ straddling: runCreated });
    await start('u1', asDeps(deps));
    expect(deps.hasRunsSince).toHaveBeenCalledWith('u1', runCreated);
  });

  it('claims only after every other gate passed', async () => {
    const deps = makeGatedDeps({ hasRuns: false });
    await start('u1', asDeps(deps));
    expect(deps.users.claimBriefStart).not.toHaveBeenCalled();
  });

  it('releases its own claim when the start failed retry-safely', async () => {
    const deps = makeGatedDeps();
    deps.publishCompose.mockRejectedValue(new BriefComposeRejectedError());
    await expect(start('u1', asDeps(deps))).rejects.toMatchObject({ retrySafe: true });
    expect(deps.users.releaseBriefStart).toHaveBeenCalledWith('u1', now, PREVIOUS_START);
  });

  it('keeps the claim when the compose event may have been delivered', async () => {
    const deps = makeGatedDeps();
    deps.publishCompose.mockRejectedValue(new Error('transport timed out'));
    await expect(start('u1', asDeps(deps))).rejects.toMatchObject({
      name: BriefComposeStartError.name,
      retrySafe: false,
    });
    expect(deps.users.releaseBriefStart).not.toHaveBeenCalled();
  });

  it('releases the claim on a start error that is not a BriefComposeStartError', async () => {
    const deps = makeGatedDeps();
    const cause = new Error('database unavailable');
    deps.briefs.createComposing.mockRejectedValue(cause);
    await expect(start('u1', asDeps(deps))).rejects.toBe(cause);
    expect(deps.users.releaseBriefStart).toHaveBeenCalledWith('u1', now, PREVIOUS_START);
  });

  it('rethrows the start error even when the release itself fails', async () => {
    const deps = makeGatedDeps();
    const cause = new BriefComposeRejectedError();
    deps.publishCompose.mockRejectedValue(cause);
    deps.users.releaseBriefStart.mockRejectedValue(new Error('release failed'));
    await expect(start('u1', asDeps(deps))).rejects.toMatchObject({ retrySafe: true, cause });
  });
});

describe('startBlockBrief held-runs summary', () => {
  const block = { start: new Date('2026-11-17T04:00:00Z'), end: new Date('2026-11-17T05:00:00Z') };
  const optedIn = { preferences: { busyBlockBrief: { enabled: true } } };
  const makeBlockDeps = (over: { user?: object; hasRuns?: boolean } = {}) => ({
    ...makeGatedDeps({ user: over.user ?? optedIn }),
    hasRunsBetween: vi.fn().mockResolvedValue(over.hasRuns ?? false),
    hasEmailsBetween: vi.fn().mockResolvedValue(false),
    notifyHeldRuns: vi.fn().mockResolvedValue(undefined),
  });
  const asBlockDeps = (deps: ReturnType<typeof makeBlockDeps>) => deps as unknown as BlockBriefDeps;

  it('sends none when the opt-in is off, since no push was held', async () => {
    const deps = makeBlockDeps({ user: { preferences: { busyBlockBrief: { enabled: false } } } });
    expect(await startBlockBrief('u1', block, asBlockDeps(deps))).toBe('busy_off');
    expect(deps.notifyHeldRuns).not.toHaveBeenCalled();
  });

  it('sends one for a block with no activity to brief', async () => {
    const deps = makeBlockDeps();
    expect(await startBlockBrief('u1', block, asBlockDeps(deps))).toBe('no_activity');
    expect(deps.notifyHeldRuns).toHaveBeenCalledWith('u1', block);
    expect(deps.publishCompose).not.toHaveBeenCalled();
  });

  it('sends none when the block brief starts', async () => {
    const deps = makeBlockDeps({ hasRuns: true });
    expect(await startBlockBrief('u1', block, asBlockDeps(deps))).toBe('enqueued');
    expect(deps.notifyHeldRuns).not.toHaveBeenCalled();
  });
});
