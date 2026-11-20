import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const h = vi.hoisted(() => ({
  spacesOn: vi.fn(),
  spaceMember: vi.fn(),
  spaceAdmin: vi.fn(),
  orgMember: vi.fn(),
  orgAdmin: vi.fn(),
}));
vi.mock('../middlewares/featureFlag', () => ({ isFeatureEnabled: h.spacesOn }));
vi.mock('@bike4mind/database', () => ({
  spaceRepository: { findIdsForUser: h.spaceMember, findIdsAdministeredBy: h.spaceAdmin },
  adminSettingsRepository: { getSettingsValue: async (key: string) => settings.get(key) },
  inboxRepository: { createInboxMessage: vi.fn() },
  SkillListing: {},
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findMembershipOrgIds: h.orgMember, findIdsAdministeredBy: h.orgAdmin },
}));
vi.mock('../middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));

import type { ISkillListing } from '@bike4mind/common';
import {
  adminAudienceIdsFor,
  audienceIdsFor,
  canDelistListing,
  canRestoreListing,
  canReviewListing,
  canSeeListing,
  isSelfApproved,
  loadMarketSettings,
  marketVisibilityFilter,
  meetsPublicAccountAge,
  numericSetting,
  publicVersionView,
} from './market';

describe('numericSetting', () => {
  it.each([undefined, null, '', 'abc', NaN, Infinity, -Infinity])('falls back on %s', value => {
    expect(numericSetting(value, 7)).toBe(7);
  });

  it('parses numbers and numeric strings, keeping 0 unless positive is required', () => {
    expect(numericSetting('0.5', 7)).toBe(0.5);
    expect(numericSetting(0, 7)).toBe(0);
    expect(numericSetting(0, 7, { positive: true })).toBe(7);
    expect(numericSetting(-3, 7, { positive: true })).toBe(7);
    expect(numericSetting('12', 7, { positive: true })).toBe(12);
  });
});

describe('meetsPublicAccountAge', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const minAge = { publicMinAccountAgeDays: 3 };

  it('passes an account at or past the minimum age and refuses a younger one', () => {
    expect(meetsPublicAccountAge({ createdAt: new Date(Date.now() - 3 * DAY_MS - 1000) }, minAge)).toBe(true);
    expect(meetsPublicAccountAge({ createdAt: new Date(Date.now() - 2 * DAY_MS) }, minAge)).toBe(false);
  });

  it('always passes a super-admin, even a new one', () => {
    expect(meetsPublicAccountAge({ isAdmin: true, createdAt: new Date() }, minAge)).toBe(true);
  });

  it('fails closed when the account has no creation date', () => {
    expect(meetsPublicAccountAge({}, minAge)).toBe(false);
  });
});

describe('loadMarketSettings', () => {
  beforeEach(() => settings.clear());

  it('uses the defaults when every numeric setting is unset', async () => {
    expect(await loadMarketSettings()).toMatchObject({
      minConfidence: 0.8,
      auditSampleRate: 0.1,
      reviewSlaHours: 72,
      dailySubmitLimit: 20,
      maxListingsPerUser: 25,
      publicMinAccountAgeDays: 3,
      reportAutoHideThreshold: 3,
    });
  });

  it('never yields NaN or a zero cap from a malformed value', async () => {
    for (const key of [
      'SkillMarketClassifierMinConfidence',
      'SkillMarketAuditSampleRate',
      'SkillMarketReviewSlaHours',
      'SkillMarketDailySubmitLimit',
      'SkillMarketMaxListingsPerUser',
      'SkillMarketPublicMinAccountAgeDays',
    ]) {
      settings.set(key, 'abc');
    }
    settings.set('SkillMarketReportAutoHideThreshold', 0);
    const loaded = await loadMarketSettings();
    expect(loaded).toMatchObject({
      minConfidence: 0.8,
      auditSampleRate: 0.1,
      reviewSlaHours: 72,
      dailySubmitLimit: 20,
      maxListingsPerUser: 25,
      publicMinAccountAgeDays: 3,
      reportAutoHideThreshold: 3,
    });
  });

  it('honours valid admin values, including a zero sample rate and age gate', async () => {
    settings.set('SkillMarketAuditSampleRate', '0');
    settings.set('SkillMarketPublicMinAccountAgeDays', 0);
    settings.set('SkillMarketMaxListingsPerUser', '5');
    expect(await loadMarketSettings()).toMatchObject({
      auditSampleRate: 0,
      publicMinAccountAgeDays: 0,
      maxListingsPerUser: 5,
    });
  });
});

describe('isSelfApproved', () => {
  it('is true only when the author is the approving reviewer', () => {
    expect(isSelfApproved({ reviewStatus: 'approved', reviewerUserId: 'u1' }, 'u1')).toBe(true);
    expect(isSelfApproved({ reviewStatus: 'approved', reviewerUserId: 'u2' }, 'u1')).toBe(false);
  });

  it('is false for an auto-approved or unreviewed version', () => {
    expect(isSelfApproved({ reviewStatus: 'auto_approved' }, 'u1')).toBe(false);
    expect(isSelfApproved({ reviewStatus: 'auto_approved', reviewerUserId: 'u1' }, 'u1')).toBe(false);
  });
});

describe('publicVersionView', () => {
  it('exposes selfApproved without leaking the reviewer id', () => {
    const view = publicVersionView(
      { id: 'v1', version: 1, reviewStatus: 'approved', reviewerUserId: 'u1' } as Parameters<
        typeof publicVersionView
      >[0],
      'u1'
    );
    expect(view.selfApproved).toBe(true);
    expect(view).toMatchObject({ reviewStatus: 'approved' });
    expect(view).not.toHaveProperty('reviewerUserId');
  });
});

describe('Space audience', () => {
  const SPACE = 'space-1';
  const none = { orgIds: [], spaceIds: [] };
  const spaceListing = (over: Partial<ISkillListing> = {}) =>
    ({
      visibility: 'space',
      spaceId: SPACE,
      status: 'approved',
      deletedAt: null,
      hiddenByReports: false,
      shareToken: 'tok',
      authorUserId: 'author',
      ...over,
    }) as unknown as ISkillListing;

  beforeEach(() => {
    vi.clearAllMocks();
    h.spacesOn.mockResolvedValue(true);
    h.spaceMember.mockResolvedValue([SPACE]);
    h.spaceAdmin.mockResolvedValue([SPACE]);
    h.orgMember.mockResolvedValue(['org-a']);
    h.orgAdmin.mockResolvedValue(['org-b']);
  });

  describe('audienceIdsFor / adminAudienceIdsFor', () => {
    it('merges member and administered orgs and adds the live Spaces', async () => {
      expect(await audienceIdsFor('u1')).toEqual({ orgIds: ['org-a', 'org-b'], spaceIds: [SPACE] });
      expect(await adminAudienceIdsFor('u1')).toEqual({ orgIds: ['org-b'], spaceIds: [SPACE] });
    });

    it('returns no Spaces, and never reads them, while EnableSpaces is off', async () => {
      h.spacesOn.mockResolvedValue(false);
      expect(await audienceIdsFor('u1')).toEqual({ orgIds: ['org-a', 'org-b'], spaceIds: [] });
      expect(await adminAudienceIdsFor('u1')).toEqual({ orgIds: ['org-b'], spaceIds: [] });
      expect(h.spaceMember).not.toHaveBeenCalled();
      expect(h.spaceAdmin).not.toHaveBeenCalled();
    });
  });

  describe('marketVisibilityFilter', () => {
    it('admits a Space listing only for the audience Spaces', () => {
      const { $or } = marketVisibilityFilter({ orgIds: ['o'], spaceIds: [SPACE] }) as { $or: object[] };
      expect($or).toContainEqual({ visibility: 'space', spaceId: { $in: [SPACE] } });
      const empty = marketVisibilityFilter(none) as { $or: object[] };
      expect(empty.$or).toContainEqual({ visibility: 'space', spaceId: { $in: [] } });
    });
  });

  describe('canSeeListing', () => {
    it('shows an approved Space listing to a member of that Space only', () => {
      expect(canSeeListing(spaceListing(), { orgIds: [], spaceIds: [SPACE] })).toBe(true);
      expect(canSeeListing(spaceListing(), { orgIds: [], spaceIds: ['other'] })).toBe(false);
      expect(canSeeListing(spaceListing(), none)).toBe(false);
    });

    it('does not let an org membership, a share token or a prior import open a Space listing', () => {
      expect(canSeeListing(spaceListing(), { orgIds: [SPACE], spaceIds: [] }, 'tok', true)).toBe(false);
    });

    it('hides a Space listing that is not approved, deleted or report-hidden', () => {
      const member = { orgIds: [], spaceIds: [SPACE] };
      expect(canSeeListing(spaceListing({ status: 'in_review' }), member)).toBe(false);
      expect(canSeeListing(spaceListing({ deletedAt: new Date() }), member)).toBe(false);
      expect(canSeeListing(spaceListing({ hiddenByReports: true }), member)).toBe(false);
    });
  });

  describe('review, delist and restore', () => {
    const admin = { orgIds: [], spaceIds: [SPACE] };

    it('lets a Space admin review, delist and restore a Space listing, self-approval included', () => {
      const own = spaceListing({ authorUserId: 'space-admin' });
      expect(canReviewListing(own, { id: 'space-admin' }, admin)).toBe(true);
      expect(canDelistListing(own, { id: 'space-admin' }, admin)).toBe(true);
      expect(canRestoreListing(spaceListing(), { id: 'space-admin' }, admin)).toBe(true);
    });

    it("refuses an admin of another Space, an org admin, and a plain member's empty admin audience", () => {
      expect(canReviewListing(spaceListing(), { id: 'x' }, { orgIds: [], spaceIds: ['other'] })).toBe(false);
      expect(canReviewListing(spaceListing(), { id: 'x' }, { orgIds: [SPACE], spaceIds: [] })).toBe(false);
      expect(canDelistListing(spaceListing(), { id: 'x' }, none)).toBe(false);
      expect(canRestoreListing(spaceListing(), { id: 'x' }, none)).toBe(false);
    });

    it('keeps a super-admin takedown out of a Space admin restore, and lets a super-admin do everything', () => {
      const taken = spaceListing({ status: 'delisted', delistedBySuperAdmin: true });
      expect(canRestoreListing(taken, { id: 'space-admin' }, admin)).toBe(false);
      expect(canReviewListing(spaceListing(), { id: 'root', isAdmin: true }, none)).toBe(true);
      expect(canRestoreListing(taken, { id: 'root', isAdmin: true }, none)).toBe(true);
    });
  });
});
