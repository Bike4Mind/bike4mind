import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetValidTokens } = vi.hoisted(() => ({ mockGetValidTokens: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianTokenManager', () => ({
  AtlassianTokenManager: { getValidTokens: mockGetValidTokens },
}));

import { canSubscriberViewJiraEvent } from './subscriberAccess';

const config = { atlassianCloudId: 'cloud-1', createdBy: 'creator' };
const issuePayload = { webhookEvent: 'jira:issue_updated', issue: { key: 'SEC-7', fields: {} } };
const sprintPayload = { webhookEvent: 'sprint_started', sprint: { name: 'S1', originBoardId: 12 } };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  mockGetValidTokens.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', cloudId: 'cloud-1', siteUrl: 'x' });
  fetchMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canSubscriberViewJiraEvent', () => {
  it('allows an issue event the subscriber can read with their own token', async () => {
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: issuePayload })).resolves.toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/SEC-7?fields=project',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer at' }) })
    );
  });

  it('denies an issue event the subscriber cannot read', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: issuePayload })).resolves.toBe(
      false
    );
  });

  it('checks the comment itself for comment events, so comment visibility applies', async () => {
    const payload = {
      webhookEvent: 'comment_created',
      issue: { key: 'SEC-7', fields: {} },
      comment: { id: '10042', visibility: { type: 'role', value: 'Administrators' } },
    };
    fetchMock.mockImplementation(async (url: string) => ({ ok: !url.includes('/comment/') }));
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/SEC-7/comment/10042',
      expect.anything()
    );
  });

  it('checks the issue for comment_deleted, which has no readable comment', async () => {
    const payload = { webhookEvent: 'comment_deleted', issue: { key: 'SEC-7', fields: {} }, comment: { id: '10042' } };
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/SEC-7?fields=project',
      expect.anything()
    );
  });

  it('denies a subscriber no longer connected to the config site', async () => {
    mockGetValidTokens.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', cloudId: 'other', siteUrl: 'x' });
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: issuePayload })).resolves.toBe(
      false
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies a subscriber with no Atlassian connection or a token error', async () => {
    mockGetValidTokens.mockResolvedValueOnce(null);
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: issuePayload })).resolves.toBe(
      false
    );
    mockGetValidTokens.mockRejectedValueOnce(new Error('reconnect'));
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: issuePayload })).resolves.toBe(
      false
    );
  });

  it('denies when the Jira lookup throws', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: issuePayload })).resolves.toBe(
      false
    );
  });

  it('checks board access for sprint events', async () => {
    await canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: sprintPayload });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/agile/1.0/board/12',
      expect.any(Object)
    );

    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload: sprintPayload })).resolves.toBe(
      false
    );
  });

  it('delivers events with no issue or board only to the config creator', async () => {
    const payload = { webhookEvent: 'project_created' };
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload })).resolves.toBe(false);
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'creator', config, payload })).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat a malformed issue key as an issue', async () => {
    const payload = { webhookEvent: 'jira:issue_updated', issue: { key: '../../myself' } };
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks project browse permission for a deleted issue', async () => {
    const payload = {
      webhookEvent: 'jira:issue_deleted',
      issue: { key: 'SEC-7', fields: { project: { key: 'SEC' } } },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { BROWSE_PROJECTS: { havePermission: true } } }),
    });

    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/mypermissions?projectKey=SEC&permissions=BROWSE_PROJECTS',
      expect.any(Object)
    );

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ permissions: { BROWSE_PROJECTS: { havePermission: false } } }),
    });
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'u1', config, payload })).resolves.toBe(false);
  });

  it('denies a deleted issue with no project to check', async () => {
    const payload = { webhookEvent: 'jira:issue_deleted', issue: { key: 'SEC-7' } };
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'creator', config, payload })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks project browse permission for project events', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const payload = { webhookEvent: 'project_updated', project: { key: 'SEC' } };
    await expect(canSubscriberViewJiraEvent({ subscriberUserId: 'creator', config, payload })).resolves.toBe(false);
  });
});
