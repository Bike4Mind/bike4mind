import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    projectExists: vi.fn(),
    agentCount: vi.fn(),
    dataLakeFindOne: vi.fn(),
    fabFileExists: vi.fn(),
    publishedExists: vi.fn(),
    txFind: vi.fn(),
    addCredits: vi.fn(),
    artifactExists: vi.fn(),
    apiKeyExists: vi.fn(),
    usageDistinct: vi.fn(),
    stampedKeys: vi.fn(),
    miscExists: vi.fn(),
    miscFindOne: vi.fn(),
    importFindOne: vi.fn(),
    overridesByKey: vi.fn(),
    claimOnce: vi.fn(),
    hearthHasAnyChannel: vi.fn(),
  },
}));

// baseApi mock: callable chain routed by req.method (same shape as the serve tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

vi.mock('@bike4mind/database', () => ({
  Project: { exists: (...a: unknown[]) => mocks.projectExists(...a) },
  FabFile: { exists: (...a: unknown[]) => mocks.fabFileExists(...a) },
  PublishedArtifact: { exists: (...a: unknown[]) => mocks.publishedExists(...a) },
  Artifact: { exists: (...a: unknown[]) => mocks.artifactExists(...a) },
  ApiKey: { exists: (...a: unknown[]) => mocks.apiKeyExists(...a) },
  UsageEvent: { distinct: (...a: unknown[]) => mocks.usageDistinct(...a) },
  User: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  Session: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  Agent: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  Memento: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  QuestMasterPlan: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  McpServer: { exists: (...a: unknown[]) => mocks.miscExists(...a) },
  agentRepository: { countByUserId: (...a: unknown[]) => mocks.agentCount(...a) },
  dataLakeRepository: { findOne: (...a: unknown[]) => mocks.dataLakeFindOne(...a) },
  creditTransactionRepository: { find: (...a: unknown[]) => mocks.txFind(...a) },
  gearStampRepository: {
    stampedKeys: (...a: unknown[]) => mocks.stampedKeys(...a),
    claimOnce: (...a: unknown[]) => mocks.claimOnce(...a),
  },
  gearOverrideRepository: { byKey: (...a: unknown[]) => mocks.overridesByKey(...a) },
  hearthRepository: { hasAnyChannelForUser: (...a: unknown[]) => mocks.hearthHasAnyChannel(...a) },
  importHistoryJobRepository: { findOne: (...a: unknown[]) => mocks.importFindOne(...a) },
  rapidReplyAuditLogRepository: { findOne: (...a: unknown[]) => mocks.miscFindOne(...a) },
  researchDataRepository: { findOne: (...a: unknown[]) => mocks.miscFindOne(...a) },
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: (...a: unknown[]) => mocks.addCredits(...a) },
}));
vi.mock('@bike4mind/common', () => ({
  CreditHolderType: { User: 'User' },
}));

import handler, { GEAR_DEFAULTS } from '../status';
import { groupGearsByTab } from '@client/lib/gears/tabs';

const run = (user?: { id: string }) => {
  const { req, res } = createMocks({ method: 'GET' });
  if (user) (req as Record<string, unknown>).user = user;
  return {
    res,
    promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res),
  };
};

const lockEverything = () => {
  mocks.projectExists.mockResolvedValue(null);
  mocks.agentCount.mockResolvedValue(0);
  mocks.dataLakeFindOne.mockResolvedValue(null);
  mocks.fabFileExists.mockResolvedValue(null);
  mocks.publishedExists.mockResolvedValue(null);
  mocks.artifactExists.mockResolvedValue(null);
  mocks.apiKeyExists.mockResolvedValue(null);
  mocks.usageDistinct.mockResolvedValue([]);
  mocks.stampedKeys.mockResolvedValue(new Set());
  mocks.miscExists.mockResolvedValue(null);
  mocks.miscFindOne.mockResolvedValue(null);
  mocks.importFindOne.mockResolvedValue(null);
  mocks.overridesByKey.mockResolvedValue(new Map());
  mocks.claimOnce.mockResolvedValue(true);
  mocks.hearthHasAnyChannel.mockResolvedValue(false);
  mocks.txFind.mockResolvedValue([]);
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  lockEverything();
  mocks.addCredits.mockResolvedValue({ currentCredits: 100 });
});

describe('GET /api/gears/status', () => {
  it('401s without a user', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it('reports all gears locked for a brand-new user and grants nothing', async () => {
    const { res, promise } = run({ id: 'u1' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData() as { gears: Array<{ unlocked: boolean }>; totalUnlocked: number };
    expect(body.gears).toHaveLength(GEAR_DEFAULTS.length);
    expect(body.gears.every(g => !g.unlocked)).toBe(true);
    expect(body.totalUnlocked).toBe(0);
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });

  it('derives unlocks from data existence and reports the reward as claimable without paying it', async () => {
    // Answer true only for the destination arm ($or query), not the shareproject arm.
    mocks.projectExists.mockImplementation((q: { $or?: unknown }) => Promise.resolve(q.$or ? { _id: 'p1' } : null));
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean; claimable?: boolean }> };
    const projects = body.gears.find(g => g.key === 'projects')!;
    expect(projects.unlocked).toBe(true);
    expect(projects.claimable).toBe(true);
    // Read-only: the payout is POST /api/gears/claim's job.
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.claimOnce).not.toHaveBeenCalled();
  });

  it('a gear already in the ledger is not claimable', async () => {
    mocks.projectExists.mockImplementation((q: { $or?: unknown }) => Promise.resolve(q.$or ? { _id: 'p1' } : null));
    mocks.txFind.mockResolvedValue([{ transactionId: 'gear-unlock:u1:projects' }]);

    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean; claimable?: boolean }> };
    const projects = body.gears.find(g => g.key === 'projects')!;
    expect(projects.unlocked).toBe(true);
    expect(projects.claimable).toBeUndefined();
  });

  it('a paid gear stays claimed after its unlock lapses (e.g. the only agent was deleted)', async () => {
    mocks.txFind.mockResolvedValue([{ transactionId: 'gear-unlock:u1:agents' }]);
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as {
      gears: Array<{ key: string; unlocked: boolean; claimable?: boolean; claimed?: boolean }>;
    };
    const agents = body.gears.find(g => g.key === 'agents')!;
    expect(agents.unlocked).toBe(false);
    expect(agents.claimed).toBe(true);
    expect(agents.claimable).toBeUndefined();
  });

  it('a locked gear is not claimable', async () => {
    const { res, promise } = run({ id: 'u1' });
    await promise;
    const body = res._getJSONData() as { gears: Array<{ claimable?: boolean }> };
    expect(body.gears.some(g => g.claimable)).toBe(false);
  });

  it('unlock by receipt: project membership (not just ownership) is queried', async () => {
    const { promise } = run({ id: 'u1' });
    await promise;
    // users.userId is the stored membership path (sharingService pushShareable
    // writes { userId, permissions }); users.id matches nothing in Mongo.
    expect(mocks.projectExists).toHaveBeenCalledWith({
      $or: [{ userId: 'u1' }, { 'users.userId': 'u1' }],
    });
  });
});

describe('GET /api/gears/status - skill gears', () => {
  it('derives image/voice/apicall from the usage ledger and model-explorer from distinct chat models', async () => {
    mocks.usageDistinct.mockImplementation((field: string) =>
      Promise.resolve(field === 'feature' ? ['chat', 'image_generation', 'voice'] : ['gpt-x', 'claude-y'])
    );
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; kind: string; unlocked: boolean }> };
    const byKey = Object.fromEntries(body.gears.map(g => [g.key, g]));
    expect(byKey.image.unlocked).toBe(true);
    expect(byKey.voice.unlocked).toBe(true);
    expect(byKey.models.unlocked).toBe(true); // two distinct chat models
    expect(byKey.apicall.unlocked).toBe(false); // no completion_api events
    expect(byKey.image.kind).toBe('skill');
  });

  it('skill rewards use the skill credit amount, destinations the destination amount', async () => {
    mocks.apiKeyExists.mockResolvedValue({ _id: 'k1' });
    mocks.projectExists.mockImplementation((q: { $or?: unknown }) => Promise.resolve(q.$or ? { _id: 'p1' } : null));

    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as {
      gears: Array<{ key: string; claimable?: boolean; credits: number }>;
    };
    const byKey = Object.fromEntries(body.gears.map(g => [g.key, g]));
    expect(byKey.apikey.claimable).toBe(true);
    expect(byKey.projects.claimable).toBe(true);
    expect(byKey.projects.credits).toBe(1000);
    expect(byKey.apikey.credits).toBe(500);
  });
});

describe('GET /api/gears/status - hearth destination', () => {
  it('is derived from owning at least one channel, not from a stamp', async () => {
    mocks.hearthHasAnyChannel.mockResolvedValue(true);
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; kind: string; unlocked: boolean }> };
    const hearth = body.gears.find(g => g.key === 'hearth')!;
    expect(hearth.unlocked).toBe(true);
    expect(hearth.kind).toBe('destination');
    expect(mocks.hearthHasAnyChannel).toHaveBeenCalledWith('u1');
  });

  it('stays locked with zero channels', async () => {
    const { res, promise } = run({ id: 'u1' });
    await promise;
    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean }> };
    expect(body.gears.find(g => g.key === 'hearth')!.unlocked).toBe(false);
  });
});

describe('GET /api/gears/status - stamp-backed gears', () => {
  it('unlocks download/fork from first-use stamps', async () => {
    mocks.stampedKeys.mockResolvedValue(new Set(['forknotebook']));
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean }> };
    const byKey = Object.fromEntries(body.gears.map(g => [g.key, g]));
    expect(byKey.forknotebook.unlocked).toBe(true);
    expect(byKey.downloadnotebook.unlocked).toBe(false);
  });
});

describe('GET /api/gears/status - reward schedule', () => {
  it('social gears pay 5000; destinations 1000; skills scale 100-1000 by complexity', async () => {
    const { res, promise } = run({ id: 'u1' });
    await promise;
    const body = res._getJSONData() as { gears: Array<{ key: string; credits: number }> };
    const byKey = Object.fromEntries(body.gears.map(g => [g.key, g.credits]));
    expect(byKey.shareproject).toBe(5000); // social: pulls another person in
    expect(byKey.published).toBe(5000); // social: shares work with the world (lead-gen)
    expect(byKey.projects).toBe(1000);
    expect(byKey.agents).toBe(1000);
    expect(byKey.apicall).toBe(1000);
    expect(byKey.image).toBe(100);
    expect(byKey.forknotebook).toBe(100);
  });
});

describe('GET /api/gears/status - published reward waits for a non-owner view', () => {
  it('publishing unlocks the gear (nav slot) but the payout stays pending until an external view', async () => {
    mocks.publishedExists.mockImplementation((q: { externalViewCount?: unknown }) =>
      Promise.resolve(q.externalViewCount ? null : { _id: 'a1' })
    );
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as {
      gears: Array<{ key: string; unlocked: boolean; rewardPending?: boolean; claimable?: boolean }>;
    };
    const published = body.gears.find(g => g.key === 'published')!;
    expect(published.unlocked).toBe(true);
    expect(published.rewardPending).toBe(true);
    expect(published.claimable).toBeUndefined();
  });

  it('becomes claimable for the 5000 once a non-owner view exists', async () => {
    mocks.publishedExists.mockResolvedValue({ _id: 'a1' });
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as {
      gears: Array<{ key: string; credits: number; claimable?: boolean; rewardPending?: boolean }>;
    };
    const published = body.gears.find(g => g.key === 'published')!;
    expect(published.claimable).toBe(true);
    expect(published.rewardPending).toBeUndefined();
    expect(published.credits).toBe(5000);
  });
});

describe('GET /api/gears/status - imports are split per source', () => {
  it('unlocks ChatGPT and Claude imports independently, completed jobs only', async () => {
    mocks.importFindOne.mockImplementation((q: { source?: string; status?: string }) =>
      Promise.resolve(q.source === 'OpenAI' && q.status === 'completed' ? { _id: 'j1' } : null)
    );
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string; unlocked: boolean }> };
    const byKey = Object.fromEntries(body.gears.map(g => [g.key, g]));
    expect(byKey.importopenai.unlocked).toBe(true);
    expect(byKey.importclaude.unlocked).toBe(false);
  });
});

describe('GET /api/gears/status - Manage Gears admin overrides', () => {
  it('a disabled gear vanishes entirely (no card, no payout)', async () => {
    mocks.overridesByKey.mockResolvedValue(new Map([['image', { key: 'image', enabled: false }]]));
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as { gears: Array<{ key: string }> };
    expect(body.gears.some(g => g.key === 'image')).toBe(false);
    expect(body.gears).toHaveLength(GEAR_DEFAULTS.length - 1);
  });

  it('credits and copy overrides are ABSOLUTE and ride the response', async () => {
    mocks.projectExists.mockImplementation((q: { $or?: unknown }) => Promise.resolve(q.$or ? { _id: 'p1' } : null));
    mocks.overridesByKey.mockResolvedValue(
      new Map([['projects', { key: 'projects', credits: 1, title: 'Projects (nerfed)' }]])
    );
    const { res, promise } = run({ id: 'u1' });
    await promise;

    const body = res._getJSONData() as {
      gears: Array<{ key: string; credits: number; title: string; claimable?: boolean }>;
    };
    const projects = body.gears.find(g => g.key === 'projects')!;
    expect(projects.credits).toBe(1);
    expect(projects.title).toBe('Projects (nerfed)');
    expect(projects.claimable).toBe(true);
  });

  it('serves the code-default presentation when no override exists', async () => {
    const { res, promise } = run({ id: 'u1' });
    await promise;
    const body = res._getJSONData() as { gears: Array<{ key: string; title: string; ctaAction: string }> };
    const byKey = Object.fromEntries(body.gears.map(g => [g.key, g]));
    expect(byKey.projects.title).toBe('Projects');
    expect(byKey.clidocs.ctaAction).toContain('#stamp:clidocs');
  });
});

describe('Gears page placement of the real catalog', () => {
  // The drift guard for the page: a gear with a kind or key the tab rules do not expect
  // would otherwise vanish from the page, or show on two tabs.
  it('puts every gear on exactly one tab', () => {
    const tabs = groupGearsByTab(GEAR_DEFAULTS.map(g => ({ key: g.key, kind: g.kind })));
    const placed = Object.values(tabs)
      .flat()
      .map(g => g.key)
      .sort();
    expect(placed).toEqual(GEAR_DEFAULTS.map(g => g.key).sort());
  });
});
