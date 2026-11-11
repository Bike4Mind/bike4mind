import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockUserFindById,
  mockDestination,
  mockSessionFindOne,
  mockSessionFind,
  mockAgentFindOne,
  mockProjectFindOne,
  mockUserFindOne,
  mockUserFindByIdAndUpdate,
} = vi.hoisted(() => ({
  mockUserFindById: vi.fn(),
  mockDestination: vi.fn(),
  mockSessionFindOne: vi.fn(),
  mockSessionFind: vi.fn(),
  mockAgentFindOne: vi.fn(),
  mockProjectFindOne: vi.fn(),
  mockUserFindOne: vi.fn(),
  mockUserFindByIdAndUpdate: vi.fn(),
}));

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ resolveNotificationDestination: mockDestination }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'PATCH']?.(req, res),
      {
        use: () => chain,
        patch: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PATCH = fns[fns.length - 1]), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const selectResolving = (value: unknown) => ({ select: () => Promise.resolve(value) });

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => selectResolving(mockUserFindById(...a)),
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
    findByIdAndUpdate: (...a: unknown[]) => mockUserFindByIdAndUpdate(...a),
  },
  Session: {
    findOne: (...a: unknown[]) => selectResolving(mockSessionFindOne(...a)),
    find: (...a: unknown[]) => selectResolving(mockSessionFind(...a)),
  },
  Agent: { findOne: (...a: unknown[]) => Promise.resolve(mockAgentFindOne(...a)) },
  Project: { findOne: (...a: unknown[]) => selectResolving(mockProjectFindOne(...a)) },
}));

import handler from '../slack-settings';

const OWN = 'u1';
const OWN_NOTEBOOK = '507f1f77bcf86cd799439011';
const FOREIGN_NOTEBOOK = '507f1f77bcf86cd799439012';
const OWN_PROJECT = '507f1f77bcf86cd799439013';
const FOREIGN_PROJECT = '507f1f77bcf86cd799439014';
const DELETED_NOTEBOOK = '507f1f77bcf86cd799439015';
const AGENT_ID = '507f1f77bcf86cd799439016';

const run = (body: Record<string, unknown>, userId = OWN) => {
  const { req, res } = createMocks({ method: 'PATCH', query: { id: userId }, body });
  (req as Record<string, unknown>).user = { id: OWN, isAdmin: false };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUserFindById.mockReset();
  mockSessionFindOne.mockReset();
  mockSessionFind.mockReset();
  mockAgentFindOne.mockReset();
  mockProjectFindOne.mockReset();
  mockUserFindOne.mockReset().mockResolvedValue(null);
  mockUserFindByIdAndUpdate.mockReset().mockResolvedValue({ slackSettings: {} });
});

describe('PATCH /api/users/:id/slack-settings - defaultNotebookId ownership', () => {
  it('rejects a defaultNotebookId that does not belong to the caller', async () => {
    mockSessionFindOne.mockReturnValue(null); // not owned -> Session.findOne resolves null
    const { res, promise } = run({ defaultNotebookId: FOREIGN_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/notebook not found or does not belong/i);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts a defaultNotebookId the caller owns and persists it', async () => {
    mockSessionFindOne.mockReturnValue({ _id: OWN_NOTEBOOK });
    const { res, promise } = run({ defaultNotebookId: OWN_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
    // Scopes the ownership query to the caller.
    expect(mockSessionFindOne).toHaveBeenCalledWith(expect.objectContaining({ _id: OWN_NOTEBOOK, userId: OWN }));
  });

  it('rejects a malformed defaultNotebookId before touching the DB', async () => {
    const { res, promise } = run({ defaultNotebookId: 'not-an-object-id' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/invalid notebook id format/i);
    expect(mockSessionFindOne).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:id/slack-settings - agentNotebookRouting ownership', () => {
  it('rejects an agent routing notebook that does not belong to the caller', async () => {
    mockSessionFindOne.mockReturnValue(null);
    const { res, promise } = run({ agentNotebookRouting: { dev: FOREIGN_NOTEBOOK } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/routing notebook not found or does not belong/i);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts agent routing notebooks the caller owns and persists them', async () => {
    mockSessionFindOne.mockReturnValue({ _id: OWN_NOTEBOOK });
    const { res, promise } = run({ agentNotebookRouting: { dev: OWN_NOTEBOOK } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
    expect(mockSessionFindOne).toHaveBeenCalledWith(expect.objectContaining({ _id: OWN_NOTEBOOK, userId: OWN }));
  });

  it('rejects a malformed agent routing notebook id before touching the DB', async () => {
    const { res, promise } = run({ agentNotebookRouting: { pm: 'not-an-object-id' } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/invalid notebook id format/i);
    expect(mockSessionFindOne).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:id/slack-settings - defaultProjectId access', () => {
  it('rejects a defaultProjectId the caller cannot access', async () => {
    mockProjectFindOne.mockReturnValue(null);
    const { res, promise } = run({ defaultProjectId: FOREIGN_PROJECT });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/project not found or not accessible/i);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts a defaultProjectId the caller can access (owner or member)', async () => {
    mockProjectFindOne.mockReturnValue({ _id: OWN_PROJECT });
    const { res, promise } = run({ defaultProjectId: OWN_PROJECT });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
  });
});

describe('Slack identity and preference boundaries', () => {
  it('rejects a manually claimed Slack identity', async () => {
    mockUserFindById.mockReturnValue({ slackSettings: {} });
    const { res, promise } = run({ slackUserId: 'UVICTIM' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts the identity the OAuth callback stored', async () => {
    mockUserFindById.mockReturnValue({ slackSettings: { slackUserId: 'U1', slackTeamId: 'T1' } });
    const { res, promise } = run({ slackUserId: 'U1' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
  });

  it('lets a legacy link save preferences for its own unchanged identity', async () => {
    // Rows written before workspace verification have a Slack id but no team.
    mockUserFindById.mockReturnValue({ slackSettings: { slackUserId: 'U1' } });
    const { res, promise } = run({ slackUserId: 'U1', autoCreateNotebook: false });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
  });

  it('preserves OAuth identity when updating preferences', async () => {
    const { res, promise } = run({ autoCreateNotebook: false });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      OWN,
      {
        $set: { 'slackSettings.autoCreateNotebook': false },
        $unset: {
          'slackSettings.defaultNotebookId': 1,
          'slackSettings.notebookNamePrefix': 1,
          'slackSettings.defaultProjectId': 1,
          'slackSettings.agentNotebookRouting': 1,
          'slackSettings.keywordRouting': 1,
          'slackSettings.customAgentId': 1,
        },
      },
      { new: true, runValidators: true }
    );
  });

  it('keeps GitHub notification preferences when the Slack section saves', async () => {
    // Shape of SlackIntegrationSection.handleSave, which never sends githubNotifications.
    mockUserFindById.mockReturnValue({ slackSettings: { slackUserId: 'U1', slackTeamId: 'T1' } });
    mockSessionFindOne.mockReturnValue({ _id: OWN_NOTEBOOK });
    mockProjectFindOne.mockReturnValue({ _id: OWN_PROJECT });
    const { res, promise } = run({
      slackUserId: 'U1',
      defaultNotebookId: OWN_NOTEBOOK,
      autoCreateNotebook: true,
      notebookNamePrefix: 'Slack Chat',
      defaultProjectId: OWN_PROJECT,
      agentNotebookRouting: {},
    });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const [, update] = mockUserFindByIdAndUpdate.mock.calls[0];
    expect(update.$unset).not.toHaveProperty('slackSettings.githubNotifications');
    expect(update.$set).not.toHaveProperty('slackSettings.githubNotifications');
  });

  it('clears a keyword routing list the caller no longer sends', async () => {
    const { res, promise } = run({ agentNotebookRouting: {} });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      OWN,
      expect.objectContaining({ $unset: expect.objectContaining({ 'slackSettings.keywordRouting': 1 }) }),
      { new: true, runValidators: true }
    );
  });

  it('unlinks the identity, workspace and user token together', async () => {
    const { promise } = run({ slackUserId: '' });
    await promise;
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith(
      OWN,
      {
        $set: {},
        $unset: {
          'slackSettings.defaultNotebookId': 1,
          'slackSettings.autoCreateNotebook': 1,
          'slackSettings.notebookNamePrefix': 1,
          'slackSettings.defaultProjectId': 1,
          'slackSettings.agentNotebookRouting': 1,
          'slackSettings.keywordRouting': 1,
          'slackSettings.customAgentId': 1,
          'slackSettings.githubNotifications': 1,
          'slackSettings.slackUserId': 1,
          'slackSettings.slackTeamId': 1,
          'slackSettings.slackUserToken': 1,
          'slackSettings.slackUserScopes': 1,
        },
      },
      { new: true, runValidators: true }
    );
  });

  it('does not set and unset githubNotifications in one unlink update', async () => {
    const { promise } = run({ slackUserId: '', githubNotifications: { enabled: false } });
    await promise;
    const [, update] = mockUserFindByIdAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty('slackSettings.githubNotifications');
    expect(update.$unset).toHaveProperty('slackSettings.githubNotifications', 1);
  });

  it('refuses notification destinations whose membership cannot be verified', async () => {
    mockDestination.mockRejectedValueOnce(new Error('not a member'));
    const { res, promise } = run({ githubNotifications: { enabled: true, channels: { default: 'CFOREIGN' } } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockDestination).toHaveBeenCalledWith(OWN, 'CFOREIGN');
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('disables notifications without re-verifying a saved channel', async () => {
    const { res, promise } = run({
      githubNotifications: { enabled: false, channels: { default: 'CFOREIGN' } },
    });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockDestination).not.toHaveBeenCalled();
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:id/slack-settings - stale stored references', () => {
  const stored = (slackSettings: Record<string, unknown>) => mockUserFindById.mockReturnValue({ slackSettings });
  const update = () => mockUserFindByIdAndUpdate.mock.calls[0][1];

  it('drops a stored keyword rule whose notebook was deleted and saves the rest', async () => {
    stored({
      keywordRouting: [
        { keywords: ['bug'], notebookId: DELETED_NOTEBOOK },
        { keywords: ['ops'], notebookId: OWN_NOTEBOOK },
      ],
    });
    mockSessionFind.mockReturnValue([{ _id: OWN_NOTEBOOK }]);
    const { res, promise } = run({
      keywordRouting: [
        { keywords: ['bug'], notebookId: DELETED_NOTEBOOK },
        { keywords: ['ops'], notebookId: OWN_NOTEBOOK },
      ],
      autoCreateNotebook: false,
    });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(update().$set['slackSettings.keywordRouting']).toEqual([{ keywords: ['ops'], notebookId: OWN_NOTEBOOK }]);
    expect(res._getJSONData().removed).toEqual([{ field: 'keywordRouting', id: DELETED_NOTEBOOK }]);
  });

  it('unsets keyword routing when every stored rule is stale', async () => {
    stored({ keywordRouting: [{ keywords: ['bug'], notebookId: DELETED_NOTEBOOK }] });
    mockSessionFind.mockReturnValue([]);
    const { res, promise } = run({ keywordRouting: [{ keywords: ['bug'], notebookId: DELETED_NOTEBOOK }] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(update().$unset).toHaveProperty('slackSettings.keywordRouting', 1);
    expect(update().$set).not.toHaveProperty('slackSettings.keywordRouting');
  });

  it('rejects a new keyword rule pointing at a notebook the caller does not own', async () => {
    stored({});
    mockSessionFind.mockReturnValue([]);
    const { res, promise } = run({ keywordRouting: [{ keywords: ['bug'], notebookId: FOREIGN_NOTEBOOK }] });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/Notebook 507f1f77bcf86cd799439012 not found or does not belong to you/);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('drops an unchanged stale defaultNotebookId', async () => {
    stored({ defaultNotebookId: DELETED_NOTEBOOK });
    mockSessionFindOne.mockReturnValue(null);
    const { res, promise } = run({ defaultNotebookId: DELETED_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(update().$unset['slackSettings.defaultNotebookId']).toBe(1);
    expect(res._getJSONData().removed).toContainEqual({ field: 'defaultNotebookId', id: DELETED_NOTEBOOK });
  });

  it('still rejects a changed defaultNotebookId the caller does not own', async () => {
    stored({ defaultNotebookId: DELETED_NOTEBOOK });
    mockSessionFindOne.mockReturnValue(null);
    const { res, promise } = run({ defaultNotebookId: FOREIGN_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('drops an unchanged stale agent routing notebook and keeps the others', async () => {
    stored({ agentNotebookRouting: { dev: DELETED_NOTEBOOK, pm: OWN_NOTEBOOK } });
    mockSessionFindOne.mockImplementation((q: { _id: string }) => (q._id === OWN_NOTEBOOK ? { _id: q._id } : null));
    const { res, promise } = run({ agentNotebookRouting: { dev: DELETED_NOTEBOOK, pm: OWN_NOTEBOOK } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(update().$set['slackSettings.agentNotebookRouting']).toEqual({ pm: OWN_NOTEBOOK });
    expect(res._getJSONData().removed).toEqual([{ field: 'agentNotebookRouting.dev', id: DELETED_NOTEBOOK }]);
  });

  it('drops an unchanged inaccessible defaultProjectId', async () => {
    stored({ defaultProjectId: FOREIGN_PROJECT });
    mockProjectFindOne.mockReturnValue(null);
    const { res, promise } = run({ defaultProjectId: FOREIGN_PROJECT });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(update().$unset['slackSettings.defaultProjectId']).toBe(1);
    expect(res._getJSONData().removed).toContainEqual({ field: 'defaultProjectId', id: FOREIGN_PROJECT });
  });

  it('drops an unchanged inaccessible customAgentId', async () => {
    stored({ customAgentId: AGENT_ID });
    mockAgentFindOne.mockReturnValue(null);
    const { res, promise } = run({ customAgentId: AGENT_ID });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(update().$unset['slackSettings.customAgentId']).toBe(1);
    expect(res._getJSONData().removed).toContainEqual({ field: 'customAgentId', id: AGENT_ID });
  });

  it('refuses a changed customAgentId the caller cannot access', async () => {
    stored({});
    mockAgentFindOne.mockReturnValue(null);
    const { res, promise } = run({ customAgentId: AGENT_ID });
    await promise;
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData().error).toBe('Failed to update settings');
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a mixed keyword save when the new rule points at a foreign notebook', async () => {
    stored({ keywordRouting: [{ keywords: ['bug'], notebookId: DELETED_NOTEBOOK }] });
    mockSessionFind.mockReturnValue([]);
    const { res, promise } = run({
      keywordRouting: [
        { keywords: ['bug'], notebookId: DELETED_NOTEBOOK },
        { keywords: ['x'], notebookId: FOREIGN_NOTEBOOK },
      ],
    });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toContain(FOREIGN_NOTEBOOK);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a changed agent routing notebook the caller does not own', async () => {
    stored({ agentNotebookRouting: { dev: DELETED_NOTEBOOK } });
    mockSessionFindOne.mockReturnValue(null);
    const { res, promise } = run({ agentNotebookRouting: { dev: FOREIGN_NOTEBOOK } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe('Agent routing notebook not found or does not belong to you');
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a stale agent routing id moved to a different key', async () => {
    stored({ agentNotebookRouting: { dev: DELETED_NOTEBOOK } });
    mockSessionFindOne.mockReturnValue(null);
    const { res, promise } = run({ agentNotebookRouting: { pm: DELETED_NOTEBOOK } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a changed defaultProjectId the caller cannot access', async () => {
    stored({ defaultProjectId: FOREIGN_PROJECT });
    mockProjectFindOne.mockReturnValue(null);
    const { res, promise } = run({ defaultProjectId: OWN_PROJECT });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toBe('Default project not found or not accessible');
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('omits removed when nothing was stale', async () => {
    stored({ defaultNotebookId: OWN_NOTEBOOK });
    mockSessionFindOne.mockReturnValue({ _id: OWN_NOTEBOOK });
    const { res, promise } = run({ defaultNotebookId: OWN_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).not.toHaveProperty('removed');
  });

  it('drops an unchanged malformed stored defaultNotebookId without querying', async () => {
    stored({ defaultNotebookId: 'legacy-bad' });
    const { res, promise } = run({ defaultNotebookId: 'legacy-bad' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().removed).toContainEqual({ field: 'defaultNotebookId', id: 'legacy-bad' });
    expect(mockSessionFindOne).not.toHaveBeenCalled();
  });
});
