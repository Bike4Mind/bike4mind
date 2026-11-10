import { describe, expect, it } from 'vitest';
import { CAMPAIGN_WATCH_MAX_MEMBERS, CampaignWatchChangeSchema, CampaignWatchCreateSchema } from './campaignWatch';

const id = 'abcdefabcdefabcdefabcdef';
describe('campaign watch requests', () => {
  it('normalizes ids while retaining an exact, unique membership', () => {
    const result = CampaignWatchCreateSchema.parse({
      name: ' Watch ',
      userIds: [id.toUpperCase()],
      reason: 'Monitor account activity',
    });
    expect(result.name).toBe('Watch');
    expect(result.userIds).toEqual([id]);
  });
  it.each([
    { label: 'empty', userIds: [] },
    { label: 'duplicate after normalization', userIds: [id, id.toUpperCase()] },
    { label: 'malformed id', userIds: ['invalid'] },
    {
      label: 'over the member cap',
      userIds: Array.from({ length: CAMPAIGN_WATCH_MAX_MEMBERS + 1 }, (_, index) =>
        index.toString(16).padStart(24, '0')
      ),
    },
  ])('rejects invalid membership: $label', ({ userIds }) => {
    expect(CampaignWatchCreateSchema.safeParse({ name: 'Watch', userIds, reason: 'Monitor activity' }).success).toBe(
      false
    );
  });
  it('requires a reason, revision and named action for changes', () => {
    expect(CampaignWatchChangeSchema.safeParse({ action: 'close', expectedRevision: 0, reason: '' }).success).toBe(
      false
    );
    expect(
      CampaignWatchChangeSchema.safeParse({ action: 'suspend', expectedRevision: 0, reason: 'Monitor activity' })
        .success
    ).toBe(false);
    expect(
      CampaignWatchChangeSchema.safeParse({ action: 'check', expectedRevision: 0, reason: 'Reviewed activity' }).success
    ).toBe(true);
  });
});
