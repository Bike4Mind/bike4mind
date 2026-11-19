import { describe, expect, it, vi } from 'vitest';
import type { IAssistantBrief } from '@bike4mind/database';
import {
  BriefComposeStartError,
  startBriefComposition,
  startEventBrief,
  startScheduledBrief,
  type ScheduledBriefDeps,
} from './startBriefComposition';
import { BRIEF_MIN_GAP_MS } from './briefSchedule';
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

const makeDeps = (over: { inFlight?: IAssistantBrief | null; latest?: IAssistantBrief | null } = {}) => ({
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
});

type GatedOver = {
  user?: object | null;
  inFlight?: IAssistantBrief | null;
  hasRuns?: boolean;
  claimed?: boolean;
};

const enabledUser = { preferences: { briefSchedule: { enabled: true } } };

const makeGatedDeps = (over: GatedOver = {}) => {
  const base = makeDeps({ inFlight: over.inFlight });
  return {
    ...base,
    users: {
      findById: vi.fn().mockResolvedValue(over.user === undefined ? enabledUser : over.user),
      claimBriefStart: vi.fn().mockResolvedValue(over.claimed ?? true),
      releaseBriefStart: vi.fn().mockResolvedValue(true),
    },
    hasRunsSince: vi.fn().mockResolvedValue(over.hasRuns ?? true),
  };
};
const asDeps = (deps: ReturnType<typeof makeGatedDeps>) => deps as unknown as ScheduledBriefDeps;

describe.each([
  ['startEventBrief', startEventBrief],
  ['startScheduledBrief', startScheduledBrief],
] as const)('%s', (_name, start) => {
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

  it('claims the shared gap at the gate time, then publishes a scheduled compose', async () => {
    const deps = makeGatedDeps();
    expect(await start('u1', asDeps(deps))).toBe('enqueued');
    expect(deps.users.claimBriefStart).toHaveBeenCalledWith('u1', now, BRIEF_MIN_GAP_MS);
    expect(deps.publishCompose).toHaveBeenCalledWith({ briefId: 'b1', userId: 'u1', scheduled: true });
    expect(deps.users.releaseBriefStart).not.toHaveBeenCalled();
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
    expect(deps.users.releaseBriefStart).toHaveBeenCalledWith('u1', now);
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
    expect(deps.users.releaseBriefStart).toHaveBeenCalledWith('u1', now);
  });

  it('rethrows the start error even when the release itself fails', async () => {
    const deps = makeGatedDeps();
    const cause = new BriefComposeRejectedError();
    deps.publishCompose.mockRejectedValue(cause);
    deps.users.releaseBriefStart.mockRejectedValue(new Error('release failed'));
    await expect(start('u1', asDeps(deps))).rejects.toMatchObject({ retrySafe: true, cause });
  });
});
