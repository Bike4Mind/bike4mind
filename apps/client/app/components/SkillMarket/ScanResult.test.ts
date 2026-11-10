import { describe, it, expect } from 'vitest';
import type { ISkillListingVersion, SkillListingVisibility } from '@bike4mind/common';
import { heldCauses, versionOutcome } from './ScanResult';

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

describe('versionOutcome: held versions name their cause', () => {
  const held = (riskTier: 'review' | 'high', scanFindings: { severity: string; message: string }[]) =>
    versionOutcome(
      { scanStatus: 'passed', reviewStatus: 'pending', riskTier, scanFindings } as ISkillListingVersion,
      'organization'
    );

  it('lists the high findings for a high tier and ignores lower ones', () => {
    const outcome = held('high', [
      { severity: 'medium', message: 'Tells the agent to run shell commands' },
      { severity: 'high', message: 'Tells the agent to run a command that force-pushes.' },
    ]);
    expect(outcome.body).toBe(
      'A reviewer must approve it first because of: Tells the agent to run a command that force-pushes.'
    );
  });

  it('lists the medium findings for a review tier', () => {
    expect(held('review', [{ severity: 'medium', message: 'Tells the agent to run shell commands' }]).body).toContain(
      'because of: Tells the agent to run shell commands.'
    );
  });

  it('never claims the skill declares tools when no finding says so', () => {
    expect(held('high', []).body).not.toContain('declares tools');
  });

  it('caps the list and counts the rest', () => {
    const findings = ['a', 'b', 'c', 'd', 'e'].map(message => ({ severity: 'high', message }));
    expect(heldCauses(findings, 'high')).toBe('a; b; c; and 2 more');
  });
});
