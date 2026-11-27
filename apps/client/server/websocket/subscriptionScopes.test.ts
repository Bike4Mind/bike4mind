import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { InviteType } from '@bike4mind/common';
import { adminSettingsSubscriptionScope, inviteSubscriptionScope } from './subscriptionScopes';

describe('inviteSubscriptionScope', () => {
  const projectIds = [new Types.ObjectId().toString()];
  const projectArm = { $and: [{ type: InviteType.Project }, { documentId: { $in: projectIds } }] };

  it('matches invites addressed to the caller plus the shareable-project arm', () => {
    expect(inviteSubscriptionScope('user@example.com', projectIds).$or).toEqual([
      { 'recipients.pending': { $in: ['user@example.com'] } },
      projectArm,
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['blank', '   '],
  ])('drops the pending arm entirely for a %s email', (_label, email) => {
    // `$in: [undefined]` is read by Mongo as "field missing or null", so an emailless account
    // would otherwise match every invite whose recipients.pending path is absent.
    expect(inviteSubscriptionScope(email, projectIds).$or).toEqual([projectArm]);
  });

  it('trims the email before matching', () => {
    expect(inviteSubscriptionScope('  user@example.com  ', projectIds).$or?.[0]).toEqual({
      'recipients.pending': { $in: ['user@example.com'] },
    });
  });
});

describe('adminSettingsSubscriptionScope', () => {
  it('ANDs the ability scope with the broadcast-safe setting allowlist', () => {
    const abilityScope = { settingName: { $in: ['EnableArtifacts'] } };
    const scope = adminSettingsSubscriptionScope(abilityScope);

    expect(scope.$and?.[0]).toBe(abilityScope);
    const allowed = (scope.$and?.[1] as { settingName: { $in: string[] } }).settingName.$in;
    expect(allowed).toContain('EnableArtifacts');
  });

  it('keeps sensitive settings out of an unrestricted (admin) subscription', () => {
    const scope = adminSettingsSubscriptionScope({});
    const allowed = (scope.$and?.[1] as { settingName: { $in: string[] } }).settingName.$in;

    expect(allowed).not.toContain('openaiDemoKey');
    expect(allowed).not.toContain('sreAgentConfig');
  });
});
