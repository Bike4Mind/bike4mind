import { describe, it, expect } from 'vitest';
import type { ISkillListingVersion, SkillListingVisibility } from '@bike4mind/common';
import { SELF_APPROVED_LABEL, versionOutcome } from './ScanResult';

// `review`-tier rows are held now, but ones auto-approved before that change stay live; My listings
// still renders this outcome for them (routes/skills/market/mine.tsx), so the copy is pinned here.
const legacyAutoApproved = (visibility: SkillListingVisibility) =>
  versionOutcome(
    { scanStatus: 'passed', reviewStatus: 'auto_approved', riskTier: 'review' } as ISkillListingVersion,
    visibility
  );

describe('versionOutcome: auto-approved review-tier version', () => {
  it.each([
    ['organization', 'Passed the automated scan with a note and is live for your organization.'],
    ['unlisted', 'Passed the automated scan with a note and is live for your link holders.'],
  ] as const)('describes a legacy auto-approved %s listing as live', (visibility, body) => {
    expect(legacyAutoApproved(visibility)).toMatchObject({
      color: 'success',
      title: 'Live on the Skill Market',
      body,
    });
  });
});

describe('versionOutcome: approved version', () => {
  const approved = (reviewerUserId: string, authorUserId?: string) =>
    versionOutcome(
      { scanStatus: 'passed', reviewStatus: 'approved', reviewerUserId } as ISkillListingVersion,
      'organization',
      authorUserId
    );

  it('names a self-approval as such', () => {
    expect(approved('u1', 'u1').title).toBe(SELF_APPROVED_LABEL);
  });

  it('keeps "Approved by a reviewer" when a different person approved', () => {
    expect(approved('u2', 'u1').title).toBe('Approved by a reviewer');
  });

  it('keeps "Approved by a reviewer" when the author is not supplied', () => {
    expect(approved('u1').title).toBe('Approved by a reviewer');
  });
});
