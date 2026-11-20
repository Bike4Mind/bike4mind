import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  consume: vi.fn(),
  persist: vi.fn(),
  config: vi.fn(),
  legacyConfig: vi.fn(),
  create: vi.fn(),
  post: vi.fn(),
  ephemeral: vi.fn(),
  tracker: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { findByKey: mocks.find, deleteByKeyAndReturn: mocks.consume, createOrUpdate: mocks.persist },
  liveopsTriageConfigRepository: { findById: mocks.config },
  AdminSettings: { findOne: () => ({ lean: () => ({ exec: mocks.legacyConfig }) }) },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    error = vi.fn();
  },
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    chat = { postMessage: mocks.post, postEphemeral: mocks.ephemeral };
  },
}));
vi.mock('../../services/issueTrackers/index', () => ({ createIssueTracker: mocks.tracker }));
vi.mock('../../services/issueTrackers/githubIssueTracker', () => ({
  GitHubIssueTracker: class {
    createIssue = mocks.create;
  },
}));

import { createLiveopsProposalBlocks, handleLiveopsApprovalAction } from './liveopsTriageApproval';

describe('LiveOps approval', () => {
  const config = {
    approverIds: ' U1, U2 ',
    autoCreateIssues: true,
    slackWorkspaceId: 'W1',
    slackChannelId: 'C1',
    githubOwner: 'owner',
    githubRepo: 'repo',
    issueTracker: 'github',
  };
  const issue = {
    title: 'Review <!here>',
    body: 'Details <!here>',
    priority: 'P0' as const,
    labels: ['bug'],
    fingerprint: 'fp',
  };
  const context = { workspaceId: 'W1', channelId: 'C1', botToken: 'token' };
  let id: string;
  let row: { result: unknown; expiresAt: Date } | null;
  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.config.mockResolvedValue(config);
    mocks.legacyConfig.mockResolvedValue({ settingValue: { ...config, modelId: 'test' } });
    mocks.tracker.mockReturnValue({ createIssue: mocks.create });
    mocks.create.mockResolvedValue({ key: 'owner/repo#1', url: 'https://example.com/1' });
    await createLiveopsProposalBlocks(config, issue, 'config1');
    const stored = mocks.persist.mock.calls[0][0];
    id = stored.key.split(':').at(-1);
    row = stored;
    mocks.find.mockImplementation(async () => row);
    mocks.consume.mockImplementation(async () => {
      const claimed = row;
      row = null;
      return claimed;
    });
  });
  const click = (user = 'U1', action = 'liveops_approve_issue', ctx = context) =>
    handleLiveopsApprovalAction(action, id, user, ctx);

  it('persists random IDs, a TTL and issue data; buttons carry only IDs and never page', async () => {
    const blocks = await createLiveopsProposalBlocks(config, issue);
    const stored = mocks.persist.mock.calls[1][0];
    expect(stored.key).not.toBe(mocks.persist.mock.calls[0][0].key);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.result.issue).toEqual(issue);
    expect(blocks[0]).toMatchObject({ type: 'section', text: { type: 'plain_text' } });
    const actions = blocks[1];
    expect(actions.type).toBe('actions');
    if (actions.type === 'actions') {
      for (const button of actions.elements) expect(button).toMatchObject({ value: stored.key.split(':').at(-1) });
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('keeps maximum proposal previews within Slack limits without interpreting mentions', async () => {
    const blocks = await createLiveopsProposalBlocks(config, {
      ...issue,
      title: '&'.repeat(500),
      body: '&'.repeat(10000),
    });
    const section = blocks[0];
    if (section.type !== 'section') throw new Error('Expected preview');
    expect(section.text?.type).toBe('plain_text');
    expect(section.text?.text.length).toBeLessThanOrEqual(3000);
  });
  it.each(['', undefined, ' ,  '])('shows a setup notice for an empty approver list %j', async approverIds => {
    const blocks = await createLiveopsProposalBlocks({ ...config, approverIds }, issue);
    expect(blocks[0]).toMatchObject({
      text: { type: 'plain_text', text: expect.stringContaining('no approvers configured') },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('shows a setup notice for a missing workspace', async () => {
    const blocks = await createLiveopsProposalBlocks({ ...config, slackWorkspaceId: undefined }, issue);
    expect(blocks[0]).toMatchObject({
      text: { type: 'plain_text', text: expect.stringContaining('no Slack workspace configured') },
    });
  });
  it.each(['', undefined, 'OTHER'])('denies legacy approver list %s', async approverIds => {
    await createLiveopsProposalBlocks(config, issue);
    const stored = mocks.persist.mock.calls[1][0];
    row = stored;
    id = stored.key.split(':').at(-1);
    mocks.legacyConfig.mockResolvedValue({ settingValue: { ...config, modelId: 'test', approverIds } });
    await click();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['', undefined, 'OTHER'])('denies approver list %s without consuming', async approverIds => {
    mocks.config.mockResolvedValue({ ...config, approverIds });
    expect((await click()).response.text).toContain('not authorized');
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('denies unauthorized rejection', async () => {
    await click('OTHER', 'liveops_reject_issue');
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it.each([{ workspaceId: 'OTHER' }, { channelId: 'OTHER' }, { botToken: '' }])(
    'denies mismatched context %j',
    async override => {
      await click('U1', 'liveops_approve_issue', { ...context, ...override });
      expect(mocks.consume).not.toHaveBeenCalled();
    }
  );
  it('denies changed tracker targets', async () => {
    mocks.config.mockResolvedValue({ ...config, githubRepo: 'other' });
    await click();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it('creates exactly once under concurrent clicks and only then pages', async () => {
    const results = await Promise.all([click(), click()]);
    await Promise.all(results.map(result => result.deferred));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(issue);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: expect.stringContaining('<!here>') })
    );
    await click();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('rejects once without creating or paging', async () => {
    await click('U1', 'liveops_reject_issue');
    await click();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('checks expiry again after claiming even before TTL cleanup', async () => {
    row!.expiresAt = new Date(Date.now() - 1);
    await click();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('denies absent proposals', async () => {
    row = null;
    await click();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([null, new Error('timeout')])('does not page or retry ambiguous tracker failure %s', async failure => {
    if (failure) mocks.create.mockRejectedValue(failure);
    else mocks.create.mockResolvedValue(null);
    await (
      await click()
    ).deferred;
    await click();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.ephemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Could not confirm') })
    );
  });
  it('uses the legacy config allowlist and GitHub tracker', async () => {
    await createLiveopsProposalBlocks(config, issue);
    const stored = mocks.persist.mock.calls[1][0];
    row = stored;
    id = stored.key.split(':').at(-1);
    await (
      await click()
    ).deferred;
    expect(mocks.legacyConfig).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(issue);
    expect(mocks.tracker).not.toHaveBeenCalled();
  });
});
