import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dev, org } = vi.hoisted(() => ({
  dev: {
    findBySlackAppIdAndTeamId: vi.fn(),
    findByIdWithCredentials: vi.fn(),
    findBySlackAppId: vi.fn(),
  },
  org: { findBySlackTeamIdWithToken: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({ slackDevWorkspaceRepository: dev }));
vi.mock('@bike4mind/database/infra', () => ({ orgSlackWorkspaceRepository: org }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: (value: string) => `plain:${value}`,
}));

import { resolveSlackInstallation } from './resolveSlackInstallation';

const appWorkspace = { id: 'dev-1', name: 'System app', slackOAuthSigningSecret: 'app-secret' };
const orgWorkspace = { id: 'org-ws-1', slackTeamId: 'T_ORG', slackAppId: 'A_SYSTEM', slackBotToken: 'enc-org' };

beforeEach(() => {
  vi.clearAllMocks();
  dev.findBySlackAppIdAndTeamId.mockResolvedValue(null);
  dev.findBySlackAppId.mockResolvedValue(appWorkspace);
  org.findBySlackTeamIdWithToken.mockResolvedValue(orgWorkspace);
});

describe('resolveSlackInstallation', () => {
  it('uses the dev workspace registered for this exact app and team', async () => {
    dev.findBySlackAppIdAndTeamId.mockResolvedValue({ id: 'dev-2' });
    dev.findByIdWithCredentials.mockResolvedValue({
      id: 'dev-2',
      slackOAuthSigningSecret: 'dev-secret',
      slackBotToken: 'enc-dev',
    });

    const result = await resolveSlackInstallation('A_DEV', 'T_DEV');

    expect(dev.findBySlackAppIdAndTeamId).toHaveBeenCalledWith('A_DEV', 'T_DEV');
    expect(result).toMatchObject({
      ok: true,
      installation: { kind: 'dev', signingSecret: 'dev-secret', botToken: 'plain:enc-dev' },
    });
  });

  it('uses an org workspace installed through the same app', async () => {
    const result = await resolveSlackInstallation('A_SYSTEM', 'T_ORG');

    expect(dev.findBySlackAppId).toHaveBeenCalledWith('A_SYSTEM');
    expect(result).toMatchObject({
      ok: true,
      installation: { kind: 'org', signingSecret: 'app-secret', botToken: 'plain:enc-org' },
    });
  });

  it("refuses an org workspace's team when the request names a different app", async () => {
    const result = await resolveSlackInstallation('A_OTHER', 'T_ORG');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(dev.findBySlackAppId).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'T_ORG'],
    ['A_SYSTEM', undefined],
  ])('refuses a request missing an id (app %s, team %s)', async (appId, teamId) => {
    expect(await resolveSlackInstallation(appId, teamId)).toEqual({ ok: false, reason: 'missing_ids' });
    expect(dev.findBySlackAppIdAndTeamId).not.toHaveBeenCalled();
  });

  it('reports an org workspace with no bot token', async () => {
    org.findBySlackTeamIdWithToken.mockResolvedValue({ ...orgWorkspace, slackBotToken: undefined });

    expect(await resolveSlackInstallation('A_SYSTEM', 'T_ORG')).toEqual({ ok: false, reason: 'bot_token_missing' });
  });
});
