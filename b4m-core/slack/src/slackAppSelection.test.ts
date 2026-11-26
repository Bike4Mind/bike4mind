import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureSlackPackage } from './di/registry';
import { getSystemSlackAppCredentials, generateOrgSlackConnectStateToken } from './org-slack-helpers';
import { getOAuthWorkspaceWithCredentials, generateUserLinkStateToken } from './user-link-helpers';

// Newest install first, as findAllActiveWithCredentials returns them.
const newerRow = { id: 'ws-new', slackAppId: 'A_NEW', slackClientId: 'client-new', slackClientSecret: 'secret-new' };
const olderRow = { id: 'ws-old', slackAppId: 'A_OLD', slackClientId: 'client-old', slackClientSecret: 'secret-old' };
const noSecretRow = { id: 'ws-nosecret', slackAppId: 'A_NS', slackClientId: 'client-ns' };

const findAllActiveWithCredentials = vi.fn();
const findByIdWithCredentials = vi.fn();
const createStateToken = vi.fn((..._args: unknown[]) => 'state-token');

beforeEach(() => {
  vi.clearAllMocks();
  findAllActiveWithCredentials.mockResolvedValue([newerRow, olderRow]);
  findByIdWithCredentials.mockImplementation(async (id: string) => [newerRow, olderRow].find(r => r.id === id) ?? null);
  configureSlackPackage(
    { jwtStateStore: { createStateToken, verifyStateToken: vi.fn(), validateJwtSecret: () => 's' } } as never,
    { slackDevWorkspaceRepository: { findAllActiveWithCredentials, findByIdWithCredentials } } as never
  );
});

describe('getSystemSlackAppCredentials (org connect)', () => {
  it('uses the app the request names when two apps are active', async () => {
    const credentials = await getSystemSlackAppCredentials('ws-old');
    expect(credentials).toMatchObject({ workspaceId: 'ws-old', clientId: 'client-old', clientSecret: 'secret-old' });
  });

  it('returns null rather than another app when the named app is unknown or has no secret', async () => {
    expect(await getSystemSlackAppCredentials('ws-missing')).toBeNull();
    findAllActiveWithCredentials.mockResolvedValue([newerRow, noSecretRow]);
    expect(await getSystemSlackAppCredentials('ws-nosecret')).toBeNull();
  });

  it('keeps the first credentialed app when none is named', async () => {
    const credentials = await getSystemSlackAppCredentials();
    expect(credentials).toMatchObject({ workspaceId: 'ws-new', clientId: 'client-new' });
  });

  it('signs the app row id into the state token', () => {
    generateOrgSlackConnectStateToken('org-1', 'user-1', 'hash', 'ws-old');
    expect(createStateToken).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', userId: 'user-1', workspaceId: 'ws-old' },
      'hash'
    );
  });
});

describe('getOAuthWorkspaceWithCredentials (user link)', () => {
  it('uses the app the request names when two apps are active', async () => {
    const result = await getOAuthWorkspaceWithCredentials('ws-old');
    expect(result).toMatchObject({ success: true, workspace: { id: 'ws-old' } });
    expect(findByIdWithCredentials).toHaveBeenCalledWith('ws-old');
  });

  it('fails rather than falling back to another app when the named app is unknown', async () => {
    const result = await getOAuthWorkspaceWithCredentials('ws-missing');
    expect(result).toMatchObject({ success: false, error: 'no_oauth_configured' });
  });

  it('keeps the first credentialed app when none is named', async () => {
    const result = await getOAuthWorkspaceWithCredentials();
    expect(result).toMatchObject({ success: true, workspace: { id: 'ws-new' } });
  });

  it('signs the app row id into the state token', () => {
    generateUserLinkStateToken('user-1', 'hash', 'ws-old');
    expect(createStateToken).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1', workspaceId: 'ws-old' },
      'hash'
    );
  });

  it('omits the app row id from the state when none is given', () => {
    generateUserLinkStateToken('user-1', 'hash');
    expect(createStateToken).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'hash');
  });
});
