import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockUserFindById,
  mockDestination,
  mockSessionFindOne,
  mockProjectFindOne,
  mockUserFindOne,
  mockUserFindByIdAndUpdate,
} = vi.hoisted(() => ({
  mockUserFindById: vi.fn(),
  mockDestination: vi.fn(),
  mockSessionFindOne: vi.fn(),
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
  Session: { findOne: (...a: unknown[]) => selectResolving(mockSessionFindOne(...a)) },
  Agent: { findOne: vi.fn() },
  Project: { findOne: (...a: unknown[]) => selectResolving(mockProjectFindOne(...a)) },
}));

import handler from '../slack-settings';

const OWN = 'u1';
const OWN_NOTEBOOK = '507f1f77bcf86cd799439011';
const FOREIGN_NOTEBOOK = '507f1f77bcf86cd799439012';
const OWN_PROJECT = '507f1f77bcf86cd799439013';
const FOREIGN_PROJECT = '507f1f77bcf86cd799439014';

const run = (body: Record<string, unknown>, userId = OWN) => {
  const { req, res } = createMocks({ method: 'PATCH', query: { id: userId }, body });
  (req as Record<string, unknown>).user = { id: OWN, isAdmin: false };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionFindOne.mockReset();
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
