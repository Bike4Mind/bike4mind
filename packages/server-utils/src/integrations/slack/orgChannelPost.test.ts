import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findByChannelId: vi.fn(),
  findWorkspace: vi.fn(),
  memberOrgIds: vi.fn(),
  tryIncrement: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement } }));
vi.mock('@bike4mind/database/infra', () => ({
  slackChannelConfigRepository: { findByChannelId: h.findByChannelId },
  orgSlackWorkspaceRepository: { findBySlackTeamIdWithToken: h.findWorkspace },
  organizationRepository: { findMembershipOrgIds: h.memberOrgIds },
}));

import { authorizeOrgChannelPost, spendSlackChannelBudget } from './orgChannelPost';

const CHANNEL = 'C0123ABC';

beforeEach(() => {
  vi.clearAllMocks();
  h.findByChannelId.mockResolvedValue({ slackTeamId: 'T1', apiPostEnabled: true, apiPostOrganizationId: 'org-1' });
  h.findWorkspace.mockResolvedValue({ organizationId: 'org-1', slackBotToken: 'enc' });
  h.memberOrgIds.mockResolvedValue(['org-1']);
});

describe('authorizeOrgChannelPost', () => {
  it('allows a member of the opting-in org and returns the still-encrypted token', async () => {
    expect(await authorizeOrgChannelPost({ channelId: CHANNEL, userId: 'u1' })).toEqual({
      ok: true,
      organizationId: 'org-1',
      encryptedBotToken: 'enc',
    });
  });

  it('refuses a caller with no key when the channel lists allowed keys', async () => {
    h.findByChannelId.mockResolvedValue({
      slackTeamId: 'T1',
      apiPostEnabled: true,
      apiPostOrganizationId: 'org-1',
      apiPostAllowedKeyIds: ['k1'],
    });
    expect(await authorizeOrgChannelPost({ channelId: CHANNEL, userId: 'u1' })).toEqual({
      ok: false,
      reason: 'key_not_allowlisted',
    });
    expect((await authorizeOrgChannelPost({ channelId: CHANNEL, userId: 'u1', keyId: 'k1' })).ok).toBe(true);
  });

  it.each([
    ['channel_not_enabled', () => h.findByChannelId.mockResolvedValue(null)],
    ['workspace_not_connected', () => h.findWorkspace.mockResolvedValue(null)],
    ['opt_in_from_other_org', () => h.findWorkspace.mockResolvedValue({ organizationId: 'org-2' })],
    ['not_org_member', () => h.memberOrgIds.mockResolvedValue(['org-9'])],
  ])('refuses with %s', async (reason, arrange) => {
    arrange();
    expect(await authorizeOrgChannelPost({ channelId: CHANNEL, userId: 'u1' })).toMatchObject({ ok: false, reason });
  });
});

describe('spendSlackChannelBudget', () => {
  it("spends from the v1 route's per-channel window", async () => {
    h.tryIncrement.mockResolvedValue({ success: false });
    expect(await spendSlackChannelBudget(CHANNEL)).toBe(false);
    expect(h.tryIncrement).toHaveBeenCalledWith(
      `rate-limit:channel:${CHANNEL}:POST /api/v1/slack/messages:channel-minute`,
      60,
      60_000
    );
  });
});
