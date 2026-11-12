// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreTutorialAnswersTurns, respondFromCoreTutorial } from '@bike4mind/common';
import type { ITutorialModuleProgress } from '../models';

const state = vi.hoisted(() => ({
  switchOn: true,
  progress: new Map<string, Record<string, unknown>>(),
  quests: [] as { id: string; sessionId: string; prompt: string }[],
  switchReads: 0,
  progressReads: 0,
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  isFeatureEnabled: async () => {
    state.switchReads++;
    return state.switchOn;
  },
}));
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({
  userHasEntitlement: async (user: { entitlements?: string[] }, key: string) => !!user.entitlements?.includes(key),
}));
vi.mock('../registry', async () => {
  const { FIXTURE_REGISTRY } = await import('./fixture');
  const CORE_TUTORIALS = [FIXTURE_REGISTRY];
  return { CORE_TUTORIALS, resolveCoreTutorial: (id: string) => CORE_TUTORIALS.find(t => t.id === id) ?? null };
});
vi.mock('../content', async () => {
  const { FIXTURE_CONTENT } = await import('./fixture');
  return { CORE_TUTORIAL_CONTENT: [FIXTURE_CONTENT] };
});
vi.mock('../models', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tutorialModels: () => ({
    Progress: {},
    Override: { find: () => ({ lean: async () => [] }) },
    OverrideChange: {},
    Draft: {},
  }),
}));
vi.mock('../coreDeps', () => ({ coreTutorialDepsFor: () => ({}) }));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionRepository: {
    findByIdAndUserId: async (id: string) => ({ id }),
    update: async (u: Record<string, unknown>) => state.updates.push(u),
  },
  questRepository: {
    create: async (q: Record<string, unknown>) => state.quests.push({ ...q, id: `q${state.quests.length}` } as never),
    findAllBySessionId: async (s: string) => state.quests.filter(q => q.sessionId === s),
  },
}));
vi.mock('../progressStore', () => ({
  progressStoreFor: () => ({
    all: async (u: string) => {
      state.progressReads++;
      return { ...(state.progress.get(u) ?? {}) };
    },
    claimTurn: async (u: string, m: string, s: string, from: number, to: number, at: Date) => {
      const e = state.progress.get(u)?.[m] as ITutorialModuleProgress | undefined;
      if (!e || e.sessionId !== s || e.turn !== from) return false;
      e.turn = to;
      e.turnClaimedAt = at;
      return true;
    },
    setPosition: async (u: string, m: string, stepId: string, status: string) => {
      const e = state.progress.get(u)?.[m] as Record<string, unknown> | undefined;
      if (!e) return false;
      e.stepId = stepId;
      e.status = status;
      return true;
    },
  }),
}));

import { coreTutorialTurns } from '../chatTurns';

const USER = { id: 'u1', isAdmin: false, tags: [], entitlements: ['fixture:feature'] };
const MARKED = { id: 'sess-1', tutorial: { owner: 'core' as const, moduleId: 'fixture' } };
const quest = (prompt: string) => ({ id: 'qq', prompt });

function walk(sessionId: string, turn = -1) {
  state.progress.set('u1', {
    fixture: {
      status: 'in_progress',
      sessionId,
      turn,
      moduleVersion: 1,
      moduleRevision: 0,
      turnClaimedAt: new Date(0),
      updatedAt: new Date(0),
    },
  });
}

const respond = (user: unknown, session: typeof MARKED | { id: string }, prompt: string) =>
  respondFromCoreTutorial({ user, session, quest: quest(prompt) }, coreTutorialTurns);

beforeEach(() => {
  state.switchOn = true;
  state.progress.clear();
  state.quests = [];
  state.switchReads = 0;
  state.progressReads = 0;
  state.updates = [];
  walk('sess-1');
});

describe('core scripted turns on a marked session', () => {
  it('answers the fixture turn on a main-surface session', async () => {
    const reply = await respond(USER, MARKED, 'Hello fixture');
    expect(reply?.replies).toEqual(['Hi there.']);
    expect((await respond(USER, MARKED, 'What is this?'))?.replies).toEqual(['A fixture.']);
  });

  it('clears the session marker when the prompt leaves the script', async () => {
    expect(await respond(USER, MARKED, 'Something else entirely')).toBeNull();
    expect(state.updates).toEqual([{ id: 'sess-1', tutorial: null }]);
  });

  it('does no tutorial read for a session without the marker', async () => {
    expect(await respond(USER, { id: 'sess-1' }, 'Hello fixture')).toBeNull();
    expect(await coreTutorialAnswersTurns({ user: USER, session: { id: 'sess-1' } }, coreTutorialTurns)).toBe(false);
    expect(state.progressReads).toBe(0);
    expect(state.switchReads).toBe(0);
  });

  it('leaves the turn to the model once the entitlement is revoked', async () => {
    expect(await respond({ ...USER, entitlements: [] }, MARKED, 'Hello fixture')).toBeNull();
    expect(state.progressReads).toBe(0);
  });

  it('leaves the turn to the model when the switch goes off mid-walk', async () => {
    expect((await respond(USER, MARKED, 'Hello fixture'))?.replies).toEqual(['Hi there.']);
    state.switchOn = false;
    expect(await respond(USER, MARKED, 'What is this?')).toBeNull();
    expect(await coreTutorialAnswersTurns({ user: USER, session: MARKED }, coreTutorialTurns)).toBe(false);
  });

  it('leaves a turn on the old session to the model after a restart', async () => {
    walk('sess-2');
    expect(await respond(USER, MARKED, 'Hello fixture')).toBeNull();
    expect(await coreTutorialAnswersTurns({ user: USER, session: MARKED }, coreTutorialTurns)).toBe(false);
    expect((await respond(USER, { id: 'sess-2', tutorial: MARKED.tutorial }, 'Hello fixture'))?.replies).toEqual([
      'Hi there.',
    ]);
  });

  it('refuses agent runs only while recorded turns remain', async () => {
    expect(await coreTutorialAnswersTurns({ user: USER, session: MARKED }, coreTutorialTurns)).toBe(true);
    walk('sess-1', 1);
    expect(await coreTutorialAnswersTurns({ user: USER, session: MARKED }, coreTutorialTurns)).toBe(false);
  });

  it('falls through to the model when the hook throws', async () => {
    const warn = vi.fn();
    const hook = { respond: async () => Promise.reject(new Error('boom')), answersTurns: async () => true };
    expect(
      await respondFromCoreTutorial({ user: USER, session: MARKED, quest: quest('x'), logger: { warn } }, hook)
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
