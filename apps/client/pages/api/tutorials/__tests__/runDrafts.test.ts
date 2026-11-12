// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { ITutorialModuleProgress } from '@server/tutorials/models';

const state = vi.hoisted(() => ({
  switchOn: true,
  progress: new Map<string, Record<string, unknown>>(),
  quests: [] as { id: string; sessionId: string; prompt: string }[],
  sessions: 0,
  owned: new Set<string>(),
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const { makeChain } = await import('./chain');
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
vi.mock('@server/tutorials/registry', async () => {
  const { FIXTURE_REGISTRY } = await import('@server/tutorials/__tests__/fixture');
  const CORE_TUTORIALS = [FIXTURE_REGISTRY];
  return { CORE_TUTORIALS, resolveCoreTutorial: (id: string) => CORE_TUTORIALS.find(t => t.id === id) ?? null };
});
vi.mock('@server/tutorials/content', async () => {
  const { FIXTURE_CONTENT } = await import('@server/tutorials/__tests__/fixture');
  return { CORE_TUTORIAL_CONTENT: [FIXTURE_CONTENT] };
});
vi.mock('@server/tutorials/models', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tutorialModels: () => ({
    Progress: {},
    Override: { find: () => ({ lean: async () => [] }) },
    OverrideChange: {},
    Draft: {
      find: () => ({ lean: async () => state.rows.filter(r => r.enabled) }),
      findOne: (f: { moduleId: string }) => ({
        lean: async () => state.rows.find(r => r.moduleId === f.moduleId && r.enabled) ?? null,
      }),
    },
  }),
}));
vi.mock('@server/tutorials/progressStore', () => ({
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
vi.mock('@server/tutorials/coreDeps', () => ({
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
import { CORE_DRAFT_PROFILE, coreDraftCore } from '@server/tutorials/coreDrafts';

const KEY = 'draft:feature';
const HOLDER = { id: 'u1', isAdmin: false, tags: [], entitlements: [KEY] };
const LACKING = { id: 'u2', isAdmin: false, tags: [], entitlements: [] };
const DEVELOPER = { id: 'u3', isAdmin: true, tags: [], entitlements: [] };

const transcript = [
  { prompt: 'Plan my week', reply: 'Here is a plan.' },
  { prompt: 'Now race it', reply: 'Raced.' },
];

function approvedRow(patch: Record<string, unknown> = {}) {
  const content = {
    moduleId: 'my-draft',
    title: 'My draft',
    pitch: 'A pitch.',
    transcript,
    steps: CORE_DRAFT_PROFILE.starterSteps(transcript),
    finale: CORE_DRAFT_PROFILE.defaultFinale,
    visibility: { entitlement: KEY },
  };
  return {
    ...content,
    steps: coreDraftCore.normalizeDraftSteps(content),
    enabled: true,
    revision: 0,
    contentSeq: 3,
    approvedSeq: 3,
    ...patch,
  };
}

async function post(body: unknown, user: Record<string, unknown> = HOLDER) {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  Object.assign(req, { user, logger: { warn: vi.fn(), info: vi.fn() } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), json: res._getData() ? res._getJSONData() : undefined };
}

const ids = (r: { json: { modules: { id: string }[] } }) => r.json.modules.map(m => m.id);

beforeEach(() => {
  state.switchOn = true;
  state.progress.clear();
  state.quests = [];
  state.sessions = 0;
  state.owned.clear();
  state.rows = [approvedRow()];
});

describe('serving a core draft through /api/tutorials/run', () => {
  it('lists it for a holder and a developer, and starts it for a holder', async () => {
    expect(ids(await post({ action: 'modules' }))).toContain('my-draft');
    expect(ids(await post({ action: 'modules' }, DEVELOPER))).toContain('my-draft');
    const started = await post({ action: 'start', moduleId: 'my-draft' });
    expect(started).toMatchObject({ status: 200, json: { turn: -1 } });
  });

  it('serves a public draft to anyone', async () => {
    state.rows = [approvedRow({ visibility: { public: true } })];
    expect(ids(await post({ action: 'modules' }, LACKING))).toContain('my-draft');
  });

  it.each([
    ['unapproved', { approvedSeq: 2 }],
    ['switched off', { enabled: false }],
  ])('does not serve a draft that is %s', async (_n, patch) => {
    state.rows = [approvedRow(patch)];
    expect(ids(await post({ action: 'modules' }))).not.toContain('my-draft');
    expect((await post({ action: 'start', moduleId: 'my-draft' })).status).toBe(404);
  });

  describe('a user without the entitlement', () => {
    it('does not see it in modules', async () => {
      expect(ids(await post({ action: 'modules' }, LACKING))).not.toContain('my-draft');
    });

    it('gets 404 on start', async () => {
      expect((await post({ action: 'start', moduleId: 'my-draft' }, LACKING)).status).toBe(404);
    });

    it('gets 404 on resume', async () => {
      await post({ action: 'start', moduleId: 'my-draft' });
      expect((await post({ action: 'resume', moduleId: 'my-draft' }, LACKING)).status).toBe(404);
    });

    it('gets 404 on advance', async () => {
      const { json } = await post({ action: 'start', moduleId: 'my-draft' });
      const body = { action: 'advance', moduleId: 'my-draft', sessionId: json.sessionId, turn: 0 };
      expect((await post(body, LACKING)).status).toBe(404);
      expect(state.quests).toHaveLength(0);
    });

    it('gets 404 on position', async () => {
      await post({ action: 'start', moduleId: 'my-draft' });
      const body = { action: 'position', moduleId: 'my-draft', stepId: 'turn-0', status: 'left' };
      expect((await post(body, LACKING)).status).toBe(404);
    });
  });
});
