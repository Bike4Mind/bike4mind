// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { ITutorialModuleProgress } from '@bike4mind/server-utils/tutorials/models';

const state = vi.hoisted(() => ({
  switchOn: true,
  progress: new Map<string, Record<string, unknown>>(),
  quests: [] as { id: string; sessionId: string; prompt: string }[],
  sessions: 0,
  owned: new Set<string>(),
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const { makeChain } = await import('@bike4mind/server-utils/tutorials/__tests__/chain');
  return { baseApi: (config?: unknown) => makeChain(config) };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: async () => 10 }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingByName: async () => state.switchOn,
}));
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({
  userHasEntitlement: async (user: { entitlements?: string[] }, key: string) => !!user.entitlements?.includes(key),
}));
vi.mock('@bike4mind/server-utils/tutorials/registry', async () => {
  const { FIXTURE_REGISTRY } = await import('@bike4mind/server-utils/tutorials/__tests__/fixture');
  const CORE_TUTORIALS = [FIXTURE_REGISTRY];
  return { CORE_TUTORIALS, resolveCoreTutorial: (id: string) => CORE_TUTORIALS.find(t => t.id === id) ?? null };
});
vi.mock('@bike4mind/server-utils/tutorials/content', async () => {
  const { FIXTURE_CONTENT } = await import('@bike4mind/server-utils/tutorials/__tests__/fixture');
  return { CORE_TUTORIAL_CONTENT: [FIXTURE_CONTENT] };
});
vi.mock('@bike4mind/server-utils/tutorials/models', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tutorialModels: () => ({
    Progress: {},
    Override: { find: () => ({ lean: async () => [] }) },
    OverrideChange: {},
    Draft: { find: () => ({ lean: async () => [] }) },
  }),
}));
vi.mock('@bike4mind/server-utils/tutorials/progressStore', () => ({
  progressStoreFor: () => ({
    read: async (u: string, m: string) => state.progress.get(u)?.[m],
    all: async (u: string) => ({ ...(state.progress.get(u) ?? {}) }),
    begin: async (u: string, m: string, e: unknown) => {
      state.progress.set(u, { ...(state.progress.get(u) ?? {}), [m]: e });
    },
    claimTurn: async (u: string, m: string, s: string, from: number, to: number, at: Date) => {
      const e = state.progress.get(u)?.[m] as ITutorialModuleProgress | undefined;
      if (!e || e.sessionId !== s || e.turn !== from) return false;
      e.turn = to;
      e.turnClaimedAt = at;
      return true;
    },
    reclaimTurn: async () => false,
    setPosition: async (u: string, m: string, stepId: string, status: string) => {
      const e = state.progress.get(u)?.[m] as Record<string, unknown> | undefined;
      if (!e) return false;
      e.stepId = stepId;
      e.status = status;
      return true;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/tutorials/coreDeps', () => ({
  coreTutorialDepsFor: () => ({
    ensureSheet: async () => 'sheet-1',
    createSession: async () => {
      const id = `aaaaaaaaaaaaaaaaaaaa${String(state.sessions++).padStart(4, '0')}`;
      state.owned.add(id);
      return { id };
    },
    ownsSession: async (s: string) => state.owned.has(s),
    deleteSession: async () => true,
    quests: {
      create: async (q: Record<string, unknown>) => {
        const saved = { ...q, id: `q${state.quests.length + 1}` } as (typeof state.quests)[number];
        state.quests.push(saved);
        return saved;
      },
      findAllBySessionId: async (s: string) => state.quests.filter(q => q.sessionId === s),
    },
  }),
}));

import handler from '../run';

const USER = { id: 'u1', isAdmin: false, tags: [], entitlements: ['fixture:feature'] };
const LACKING = { id: 'u2', isAdmin: false, tags: [], entitlements: [] };

async function post(body: unknown, user: Record<string, unknown> = USER) {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  Object.assign(req, { user, logger: { warn: vi.fn(), info: vi.fn() } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), json: res._getData() ? res._getJSONData() : undefined };
}

beforeEach(() => {
  state.switchOn = true;
  state.progress.clear();
  state.quests = [];
  state.sessions = 0;
  state.owned.clear();
});

describe('POST /api/tutorials/run', () => {
  it('is declared jwtOnly', () => {
    expect((handler as unknown as { _config: { auth?: string } })._config.auth).toBe('jwtOnly');
  });

  it('lets a user with the entitlement list, start and advance the fixture', async () => {
    const listed = await post({ action: 'modules' });
    expect(listed.json.modules.map((m: { id: string }) => m.id)).toEqual(['fixture']);

    const started = await post({ action: 'start', moduleId: 'fixture' });
    expect(started).toMatchObject({ status: 200, json: { turn: -1, version: 1, revision: 0 } });
    const sessionId = started.json.sessionId as string;

    expect((await post({ action: 'advance', moduleId: 'fixture', sessionId, turn: 0 })).status).toBe(200);
    expect((await post({ action: 'advance', moduleId: 'fixture', sessionId, turn: 1 })).status).toBe(200);
    expect(state.quests.map(q => q.prompt)).toEqual(['Hello fixture', 'What is this?']);

    expect(await post({ action: 'position', moduleId: 'fixture', stepId: 'done', status: 'finished' })).toMatchObject({
      status: 200,
    });
    const progress = await post({ action: 'progress' });
    expect(progress.json.modules.fixture).toMatchObject({ status: 'finished', turn: 1 });
  });

  describe('a user without the entitlement', () => {
    it('does not see the fixture in modules or progress', async () => {
      await post({ action: 'start', moduleId: 'fixture' });
      expect((await post({ action: 'modules' }, LACKING)).json.modules).toEqual([]);
      expect((await post({ action: 'progress' }, LACKING)).json.modules).toEqual({});
    });

    it('gets 404 on start', async () => {
      expect((await post({ action: 'start', moduleId: 'fixture' }, LACKING)).status).toBe(404);
    });

    it('gets 404 on resume', async () => {
      await post({ action: 'start', moduleId: 'fixture' });
      expect((await post({ action: 'resume', moduleId: 'fixture' }, LACKING)).status).toBe(404);
    });

    it('gets 404 on advance', async () => {
      const { json } = await post({ action: 'start', moduleId: 'fixture' });
      const body = { action: 'advance', moduleId: 'fixture', sessionId: json.sessionId, turn: 0 };
      expect((await post(body, LACKING)).status).toBe(404);
      expect(state.quests).toHaveLength(0);
    });

    it('gets 404 on position', async () => {
      await post({ action: 'start', moduleId: 'fixture' });
      const body = { action: 'position', moduleId: 'fixture', stepId: 'done', status: 'finished' };
      expect((await post(body, LACKING)).status).toBe(404);
    });

    it('gets 404 on sheet', async () => {
      await post({ action: 'start', moduleId: 'fixture' });
      expect((await post({ action: 'sheet', moduleId: 'fixture' }, LACKING)).status).toBe(404);
    });
  });

  it('answers 403 FEATURE_DISABLED for everything while the switch is off', async () => {
    state.switchOn = false;
    const r = await post({ action: 'modules' });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect((await post({ action: 'start', moduleId: 'fixture' })).status).toBe(403);
  });

  describe.each(['example-overlay', 'another-overlay'])('the overlay id %s', moduleId => {
    const actions = [
      { action: 'start', moduleId },
      { action: 'resume', moduleId },
      { action: 'sheet', moduleId },
      { action: 'advance', moduleId, sessionId: 'a'.repeat(24), turn: 0 },
      { action: 'position', moduleId, stepId: 'x', status: 'left' },
    ];
    it.each(actions)('404s on $action', async body => {
      for (const user of [USER, { ...USER, isAdmin: true }]) expect((await post(body, user)).status).toBe(404);
    });
  });

  it('rejects a malformed body', async () => {
    expect((await post({ action: 'nope' })).status).toBe(400);
  });
});
