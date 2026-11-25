import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { Installation } from '@slack/oauth';
import { SlackClient } from './SlackClient';
import { configureSlackPackage } from './di/registry';
import {
  createInstallProvider,
  getInstallUrlOptionsForWorkspace,
  getWorkspaceIdFromInstallState,
  type InstallCallbackOptions,
} from './installer';

const mockGetUserInfo = vi.fn();
vi.mock('./SlackClient', () => ({
  SlackClient: vi.fn(function () {
    return { getUserInfo: mockGetUserInfo };
  }),
}));

const verifyStateToken = vi.fn((..._args: unknown[]): unknown => undefined);

const rowA = { id: 'ws-a', slackAppId: 'A_APP', slackClientId: 'client-a', slackClientSecret: 'secret-a' };
const rowB = { id: 'ws-b', slackAppId: 'B_APP', slackClientId: 'client-b', slackClientSecret: 'secret-b' };

const findByIdWithCredentials = vi.fn(async (id: string) => [rowA, rowB].find(r => r.id === id) ?? null);
const findAllActiveWithCredentials = vi.fn(async () => [rowA, rowB]);
const findById = vi.fn();
const findBySlackAppId = vi.fn();
const update = vi.fn(async (_data: unknown) => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserInfo.mockResolvedValue(null);
  findBySlackAppId.mockImplementation(async (appId: string) => {
    const row = [rowA, rowB].find(r => r.slackAppId === appId);
    return row ? { id: row.id, installedAt: new Date() } : null;
  });
  configureSlackPackage(
    {
      jwtStateStore: { createStateToken: vi.fn(), verifyStateToken, validateJwtSecret: () => 'test-secret' },
      tokenEncryption: { encryptToken: (t: string) => `enc:${t}` },
    } as never,
    {
      slackDevWorkspaceRepository: {
        findByIdWithCredentials,
        findAllActiveWithCredentials,
        findById,
        findBySlackAppId,
        update,
      },
    } as never
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const clientIdOf = async (provider: Awaited<ReturnType<typeof createInstallProvider>>) => {
  const url = await provider.generateInstallUrl({ scopes: ['chat:write'] }, false);
  return new URL(url).searchParams.get('client_id');
};

const installationFor = (appId: string | undefined): Installation =>
  ({
    team: { id: 'T1', name: 'Team One' },
    appId,
    bot: { id: 'B1', userId: 'U_BOT', token: 'xoxb-new', scopes: [] },
    user: { id: 'U1' },
    isEnterpriseInstall: false,
  }) as unknown as Installation;

describe('getInstallUrlOptionsForWorkspace', () => {
  it('signs the workspace id into the install options as metadata', async () => {
    findById.mockResolvedValue({ id: 'ws-b', slackOAuthRedirectUri: 'https://example.com/cb' });
    const options = await getInstallUrlOptionsForWorkspace('ws-b');
    expect(options).toMatchObject({ redirectUri: 'https://example.com/cb', metadata: 'ws-b' });
  });
});

describe('getWorkspaceIdFromInstallState', () => {
  it('returns the workspace id carried in the state, verified with the slack audience and nonce hash', () => {
    verifyStateToken.mockReturnValue({ valid: true, payload: { installOptions: { metadata: 'ws-b' } } });
    expect(getWorkspaceIdFromInstallState('state', 'hash-a')).toBe('ws-b');
    expect(verifyStateToken).toHaveBeenCalledWith('state', { audience: 'slack-oauth-state' }, 'hash-a');
  });

  it('verifies fail-closed (null, never undefined) when the browser presents no nonce', () => {
    verifyStateToken.mockReturnValue({ valid: false, reason: 'invalid', message: 'nope' });
    expect(getWorkspaceIdFromInstallState('state', undefined)).toBeUndefined();
    expect(verifyStateToken.mock.lastCall?.[2]).toBeNull();
  });

  it('returns undefined when the state is invalid', () => {
    verifyStateToken.mockReturnValue({ valid: false, reason: 'expired', message: 'expired' });
    expect(getWorkspaceIdFromInstallState('state', 'hash-a')).toBeUndefined();
  });

  it('returns undefined when the state carries no workspace id', () => {
    verifyStateToken.mockReturnValue({ valid: true, payload: { installOptions: { scopes: ['chat:write'] } } });
    expect(getWorkspaceIdFromInstallState('state', 'hash-a')).toBeUndefined();
  });

  it('returns undefined without verifying when there is no state', () => {
    expect(getWorkspaceIdFromInstallState(undefined, 'hash-a')).toBeUndefined();
    expect(verifyStateToken).not.toHaveBeenCalled();
  });
});

describe('createInstallProvider callback workspace', () => {
  it("uses the credentials of the state's workspace when two active workspaces exist", async () => {
    const provider = await createInstallProvider({ workspaceId: 'ws-b' }, { expectedNonceHash: 'hash-a' });
    expect(await clientIdOf(provider)).toBe('client-b');
    expect(findByIdWithCredentials).toHaveBeenCalledWith('ws-b');
    expect(findAllActiveWithCredentials).not.toHaveBeenCalled();
  });

  it('falls back to the first active workspace when the state carries no workspace id', async () => {
    const provider = await createInstallProvider({ onInstallComplete: vi.fn() }, { expectedNonceHash: 'hash-a' });
    expect(await clientIdOf(provider)).toBe('client-a');
    expect(findByIdWithCredentials).not.toHaveBeenCalled();
  });

  it('still verifies the state itself through the provider state store', async () => {
    verifyStateToken.mockReturnValue({ valid: false, reason: 'invalid', message: 'nope' });
    const provider = await createInstallProvider({ workspaceId: 'ws-b' }, { expectedNonceHash: null });
    await expect(provider.stateStore!.verifyStateParam(new Date(), 'state')).rejects.toThrow();
    expect(verifyStateToken.mock.lastCall?.[2]).toBeNull();
  });

  it('throws when the state names a workspace that no longer exists', async () => {
    await expect(createInstallProvider({ workspaceId: 'ws-gone' })).rejects.toThrow('Workspace not found: ws-gone');
  });
});

describe('storeInstallation', () => {
  const store = async (opts: InstallCallbackOptions, installation: Installation) => {
    const onInstallComplete = vi.fn();
    const provider = await createInstallProvider({ ...opts, onInstallComplete }, { expectedNonceHash: 'hash-a' });
    return { run: () => provider.installationStore.storeInstallation(installation), onInstallComplete };
  };

  it('throws and writes nothing when the installed app is not the one the install started for', async () => {
    const { run, onInstallComplete } = await store({ workspaceId: 'ws-b' }, installationFor('A_APP'));
    await expect(run()).rejects.toThrow('Slack app ID does not match the selected workspace');
    expect(update).not.toHaveBeenCalled();
    expect(onInstallComplete).not.toHaveBeenCalled();
  });

  it('stores the installation when the app matches the state workspace', async () => {
    const { run, onInstallComplete } = await store({ workspaceId: 'ws-b' }, installationFor('B_APP'));
    await run();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-b', slackAppId: 'B_APP', isActive: true }));
    expect(onInstallComplete).toHaveBeenCalledWith({ isReinstall: true, teamName: 'Team One', teamId: 'T1' });
  });

  it('does not enforce an app match on the first-active fallback', async () => {
    const { run } = await store({}, installationFor('B_APP'));
    await run();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-b', slackAppId: 'B_APP' }));
  });

  it('refreshes the stored bot name from the new bot token', async () => {
    mockGetUserInfo.mockResolvedValue({ id: 'U_BOT', name: 'handle', real_name: 'Real', display_name: ' New Name ' });
    const { run } = await store({ workspaceId: 'ws-b' }, installationFor('B_APP'));
    await run();
    expect(mockGetUserInfo).toHaveBeenCalledWith('U_BOT');
    expect(SlackClient).toHaveBeenCalledWith(expect.any(String), expect.anything(), { timeoutMs: 3000 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-b', slackBotName: 'New Name' }));
  });

  it('falls back to the real name when the profile has no display name', async () => {
    mockGetUserInfo.mockResolvedValue({ id: 'U_BOT', name: 'handle', real_name: 'Real', display_name: '' });
    const { run } = await store({ workspaceId: 'ws-b' }, installationFor('B_APP'));
    await run();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ slackBotName: 'Real' }));
  });

  it.each([
    ['rejects', () => mockGetUserInfo.mockRejectedValue(new Error('slack down'))],
    ['returns null', () => mockGetUserInfo.mockResolvedValue(null)],
    ['returns no name', () => mockGetUserInfo.mockResolvedValue({ id: 'U_BOT', name: 'U_BOT' })],
  ])('keeps the stored name and still installs when the name lookup %s', async (_label, arrange) => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    arrange();
    const { run, onInstallComplete } = await store({ workspaceId: 'ws-b' }, installationFor('B_APP'));

    await expect(run()).resolves.toBeUndefined();

    const written = update.mock.calls[0][0] as Record<string, unknown>;
    expect(written).toMatchObject({ id: 'ws-b', isActive: true });
    expect(written).not.toHaveProperty('slackBotName');
    expect(onInstallComplete).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
