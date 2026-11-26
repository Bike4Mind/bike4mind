import { describe, it, expect } from 'vitest';
import {
  CHAT_MESSAGE_WITHHELD_FIELDS,
  OWNER_ONLY_CHAT_MESSAGE_FIELDS,
  ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS,
  OWNER_ONLY_PROMPT_META_PROJECTION_PATHS,
  SERVER_OWNED_SESSION_FIELDS,
  SELF_VIEW_PASSTHROUGH_FIELDS,
  USER_SECRET_FIELDS,
  USER_SECRET_SUBFIELD_PATHS,
  USER_SUBFIELD_REDACTED_FIELDS,
  redactUserSecretsForSelf,
} from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { findWithheldFilterPaths, resolveFieldLimits, type FieldLimitOptions } from './dataSubscribeFieldLimits';

const opts = (overrides: Partial<FieldLimitOptions> = {}): FieldLimitOptions => ({
  questCollectionName: 'quests',
  sessionCollectionName: 'sessions',
  organizationCollectionName: 'organizations',
  inviteCollectionName: 'invites',
  ...overrides,
});

const memberOrganizationLimits = {
  stripeCustomerId: false,
  signupGrantUnlockCount: false,
  signupInviteBonusCount: false,
  billingContact: false,
  ...Object.fromEntries(ORGANIZATION_ADMINISTRATOR_ONLY_FIELDS.map(field => [field, false])),
  'userDetails.usedCredits': false,
  'userDetails.maxCredits': false,
  'userDetails.lastCreditUsedAt': false,
  'userDetails.periodStart': false,
  'userDetails.email': false,
};

describe('resolveFieldLimits', () => {
  it('excludes every owner-only promptMeta path for the quests collection', () => {
    const limits = resolveFieldLimits('quests', opts());
    expect(limits).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
      'promptMeta.citables.metadata.fullContext': false,
      pendingAction: false,
      callback: false,
      embedding: false,
      slackNotification: false,
      signupActivity: false,
      apiKeyId: false,
      oauthClientId: false,
      pendingActionResolution: false,
      lakeSaveCount: false,
    });
  });

  it('excludes citables.metadata.fullContext, the verbatim passage behind a citation chip', () => {
    // Asserted on its own because the socket branch is a SECOND egress chokepoint next to
    // redactPromptMetaForViewer: closing the REST side alone still ships the passage to a sharee.
    expect(resolveFieldLimits('quests', opts())).toMatchObject({
      'promptMeta.citables.metadata.fullContext': false,
    });
  });

  it('derives the quest exclusions from the shared owner-only path list', () => {
    // The policy lives in @bike4mind/common; this branch must not grow a hand-maintained copy that
    // can drift from what the REST redaction enforces.
    expect(Object.keys(resolveFieldLimits('quests', opts()) ?? {}).sort()).toEqual(
      [
        ...OWNER_ONLY_PROMPT_META_PROJECTION_PATHS,
        ...OWNER_ONLY_CHAT_MESSAGE_FIELDS,
        ...CHAT_MESSAGE_WITHHELD_FIELDS,
      ].sort()
    );
  });

  it('excludes the completion callback for a sharee, since a change stream ignores select: false', () => {
    expect(resolveFieldLimits('quests', opts())).toMatchObject({ callback: false });
  });

  it('excludes the completion callback for the session owner too, since a collaborator key may have armed it', () => {
    expect(resolveFieldLimits('quests', opts({ isQuestOwner: true }))).toMatchObject({ callback: false });
  });

  it('withholds the same server-only quest fields as the REST chat routes, for owner and sharee', () => {
    // The REST side strips CHAT_MESSAGE_WITHHELD_FIELDS via chatMessageResponseSchema; a socket
    // event must not hand back what the HTTP response withheld.
    const serverOnly = Object.fromEntries(CHAT_MESSAGE_WITHHELD_FIELDS.map(field => [field, false]));
    expect(resolveFieldLimits('quests', opts({ isQuestOwner: true }))).toEqual(serverOnly);
    expect(resolveFieldLimits('quests', opts())).toMatchObject(serverOnly);
  });

  it('excludes REST server-owned session fields and the creating key for every viewer', () => {
    const expected = {
      ...Object.fromEntries(SERVER_OWNED_SESSION_FIELDS.map(field => [field, false])),
      'origin.apiKeyId': false,
    };
    expect(resolveFieldLimits('sessions', opts())).toEqual(expected);
    expect(resolveFieldLimits('sessions', opts({ isQuestOwner: true }))).toEqual(expected);
    expect(resolveFieldLimits('sessions_v2', opts({ sessionCollectionName: 'sessions_v2' }))).toEqual(expected);
  });

  it('refuses session filters that probe excluded fields while allowing display fields', () => {
    const limits = resolveFieldLimits('sessions', opts());
    expect(findWithheldFilterPaths({ 'origin.apiKeyId': { $exists: true } }, limits)).toEqual(['origin.apiKeyId']);
    expect(findWithheldFilterPaths({ systemPromptText: 'x' }, limits)).toEqual(['systemPromptText']);
    expect(findWithheldFilterPaths({ 'origin.channel': 'api' }, limits)).toEqual([]);
  });

  it('withholds every USER_SECRET_FIELDS entry the REST self-view drops, as itself or as its secret sub-paths', () => {
    const limits = resolveFieldLimits('users', opts()) ?? {};
    const rebuilt: readonly string[] = USER_SUBFIELD_REDACTED_FIELDS;
    for (const field of USER_SECRET_FIELDS) {
      if (rebuilt.includes(field)) {
        expect(limits).not.toHaveProperty(field);
        expect(Object.keys(limits).some(path => path.startsWith(`${field}.`))).toBe(true);
      } else {
        expect(limits).toHaveProperty(field, false);
      }
    }
  });

  it('withholds the admin notes, login history, signup metadata and security-answer hashes', () => {
    expect(resolveFieldLimits('users', opts())).toMatchObject({
      userNotes: false,
      loginRecords: false,
      signupMeta: false,
      securityQuestions: false,
      oauthCredentials: false,
      personaLoginCodeHash: false,
    });
  });

  it('withholds integration credentials and MFA secrets but keeps the status the client reads live', () => {
    const limits = resolveFieldLimits('users', opts()) ?? {};
    expect(limits).toMatchObject({
      'mfa.totpSecret': false,
      'mfa.backupCodes': false,
      'googleDrive.refreshToken': false,
      'atlassianConnect.accessToken': false,
      'notionConnect.accessToken': false,
      'blogIntegration.apiKey': false,
      'slackSettings.slackUserToken': false,
      'authProviders.accessToken': false,
    });
    for (const kept of ['atlassianConnect', 'atlassianConnect.status', 'mfa.totpEnabled', 'googleDrive.expiresAt']) {
      expect(limits).not.toHaveProperty(kept);
    }
  });

  it('never withholds a field the REST self-view copies through', () => {
    const limits = resolveFieldLimits('users', opts()) ?? {};
    for (const field of Object.keys(SELF_VIEW_PASSTHROUGH_FIELDS)) expect(limits).not.toHaveProperty(field);
    expect(limits).not.toHaveProperty('signupGrant');
  });

  it('classifies every User-schema field of an integration object as kept by the REST self-view or withheld', () => {
    const withheld: readonly string[] = USER_SECRET_SUBFIELD_PATHS;
    // Embedded and array-of-subdocument fields carry their own sub-schema; a plain nested object (slackSettings)
    // is only visible as dotted paths on the User schema.
    const schemaSubpaths = (field: string): string[] => {
      const own = (User.schema.path(field) as { schema?: { paths: Record<string, unknown> } } | undefined)?.schema;
      if (own) return Object.keys(own.paths);
      return Object.keys(User.schema.paths)
        .filter(path => path.startsWith(`${field}.`))
        .map(path => path.slice(field.length + 1));
    };
    for (const field of USER_SUBFIELD_REDACTED_FIELDS) {
      // A subdocument _id is not a secret and the redactor drops it along with everything else unlisted.
      const subfields = new Set(
        schemaSubpaths(field)
          .map(path => path.split('.')[0])
          .filter(sub => sub !== '$' && sub !== '_id')
      );
      expect(subfields.size, `${field} has no schema subfields`).toBeGreaterThan(0);
      const populated = Object.fromEntries([...subfields].map(sub => [sub, 'x']));
      const redacted = redactUserSecretsForSelf({
        [field]: field === 'authProviders' ? [populated] : populated,
      } as never);
      const rebuilt = redacted?.[field] as Record<string, unknown> | Array<Record<string, unknown>>;
      const kept = new Set(Object.keys(Array.isArray(rebuilt) ? rebuilt[0] : rebuilt));
      for (const sub of subfields) {
        expect(withheld.includes(`${field}.${sub}`), `${field}.${sub} must be exactly one of kept or withheld`).toBe(
          !kept.has(sub)
        );
      }
    }
  });

  it('withholds every abuse-evidence field the REST self-view drops', () => {
    // Abuse evidence describes the account to admins; a new one must be added to both lists.
    const abuseEvidence = [
      'signupGrantAssessment',
      'riskScore',
      'riskEvidence',
      'throttle',
      'riskSignals',
      'signupLanding',
      'interventionHolds',
    ] as const;
    const limits = resolveFieldLimits('users', opts());
    for (const field of abuseEvidence) {
      expect(USER_SECRET_FIELDS).toContain(field);
      expect(limits).toHaveProperty(field, false);
    }
  });

  it('refuses a users subscription filter that probes throttle or riskSignals', () => {
    const limits = resolveFieldLimits('users', opts());
    expect(findWithheldFilterPaths({ 'throttle.tier': 'shadow' }, limits)).toEqual(['throttle.tier']);
    expect(findWithheldFilterPaths({ $or: [{ riskSignals: { $exists: true } }] }, limits)).toEqual(['riskSignals']);
  });

  it('withholds only the admin block of signupGrant, not the whole sub-document the credits UI reads', () => {
    const limits = resolveFieldLimits('users', opts());
    expect(limits).toMatchObject({ 'signupGrant.blocked': false });
    expect(limits).not.toHaveProperty('signupGrant');
  });

  it('refuses a users subscription filter that probes the signup grant block', () => {
    const limits = resolveFieldLimits('users', opts());
    expect(findWithheldFilterPaths({ 'signupGrant.blocked': { $exists: true } }, limits)).toEqual([
      'signupGrant.blocked',
    ]);
    expect(findWithheldFilterPaths({ 'signupGrant.blocked.at': { $gt: new Date(0) } }, limits)).toEqual([
      'signupGrant.blocked.at',
    ]);
    expect(findWithheldFilterPaths({ 'signupGrant.heldReason': 'budget_exhausted' }, limits)).toEqual([]);
  });

  it('returns undefined for a collection with no configured limits', () => {
    expect(resolveFieldLimits('projects', opts())).toBeUndefined();
  });

  it('uses the passed-in quest collection name rather than a hardcoded literal', () => {
    // Guards against a future rename of the Quest collection silently breaking this exclusion.
    const limits = resolveFieldLimits('chathistoryitems', opts({ questCollectionName: 'chathistoryitems' }));
    expect(limits).toBeDefined();
  });

  it('does not exclude any promptMeta path for the quests collection when the caller owns the session', () => {
    // A caller-owned quest subscription must not lose returnValue - the client cache merges a WS
    // update as a top-level spread, so a promptMeta exclusion here replaces the owner's own cached
    // tool output the moment a live update lands, not just a sharee's.
    const limits = resolveFieldLimits('quests', opts({ isQuestOwner: true })) ?? {};
    expect(Object.keys(limits).filter(path => path.startsWith('promptMeta'))).toEqual([]);
  });

  it('keeps pendingAction on the quests projection for the session owner and withholds it from a sharee', () => {
    expect(resolveFieldLimits('quests', opts({ isQuestOwner: true }))).not.toHaveProperty('pendingAction');
    expect(resolveFieldLimits('quests', opts({ isQuestOwner: false }))).toMatchObject({ pendingAction: false });
  });

  it('still excludes the owner-only promptMeta paths for the quests collection when the caller is a sharee', () => {
    const limits = resolveFieldLimits('quests', opts({ isQuestOwner: false }));
    expect(limits).toEqual({
      'promptMeta.functionCalls.returnValue': false,
      'promptMeta.functionCalls.error': false,
      'promptMeta.citables.metadata.fullContext': false,
      pendingAction: false,
      callback: false,
      embedding: false,
      slackNotification: false,
      signupActivity: false,
      apiKeyId: false,
      oauthClientId: false,
      pendingActionResolution: false,
      lakeSaveCount: false,
    });
  });

  it('limits a non-privileged organizations subscriber to the member view', () => {
    expect(resolveFieldLimits('organizations', opts())).toEqual(memberOrganizationLimits);
  });

  it('withholds administrator-only settings such as systemPrompt from a member subscriber', () => {
    const limits = resolveFieldLimits('organizations', opts());
    expect(limits).toMatchObject({ systemPrompt: false, sharingPolicy: false, budgetAlerts: false });
    expect(findWithheldFilterPaths({ systemPrompt: { $regex: 'a' } }, limits)).toEqual(['systemPrompt']);
    expect(limits).not.toHaveProperty('currentCredits');
    expect(limits).not.toHaveProperty('adminUserIds');
  });

  it('keeps credit details for a verified owner or manager on a single-org subscription', () => {
    expect(resolveFieldLimits('organizations', opts({ isPrivilegedOrgSubscriber: true }))).toEqual({
      stripeCustomerId: false,
      signupGrantUnlockCount: false,
      signupInviteBonusCount: false,
      billingContact: false,
    });
  });

  it('rejects filters probing withheld member credit paths', () => {
    const limits = resolveFieldLimits('organizations', opts());
    expect(findWithheldFilterPaths({ userDetails: { $elemMatch: { usedCredits: { $gt: 0 } } } }, limits)).toEqual([
      'userDetails',
    ]);
    expect(findWithheldFilterPaths({ 'userDetails.maxCredits': { $gt: 0 } }, limits)).toEqual([
      'userDetails.maxCredits',
    ]);
    expect(findWithheldFilterPaths({ 'userDetails.name': 'Ada' }, limits)).toEqual([]);
    expect(findWithheldFilterPaths({ 'userDetails.0.usedCredits': { $gt: 0 } }, limits)).toEqual([
      'userDetails.0.usedCredits',
    ]);
    expect(findWithheldFilterPaths({ 'userDetails.0.name': 'Ada' }, limits)).toEqual([]);
  });

  it('withholds member emails from a member subscriber, as a field and as a filter path', () => {
    const limits = resolveFieldLimits('organizations', opts());
    expect(limits).toMatchObject({ 'userDetails.email': false });
    expect(limits).not.toHaveProperty(['userDetails.name']);
    expect(findWithheldFilterPaths({ 'userDetails.email': 'a@b.test' }, limits)).toEqual(['userDetails.email']);
    expect(findWithheldFilterPaths({ 'userDetails.0.email': 'a@b.test' }, limits)).toEqual(['userDetails.0.email']);
  });

  it('still excludes stripeCustomerId for a platform admin, who keeps billingContact', () => {
    // Mirrors toSafeOrganization: stripeCustomerId has no client consumer at all, billingContact
    // is privileged. Owners are NOT privileged here - see the projection note in the source.
    expect(resolveFieldLimits('organizations', opts({ isPlatformAdmin: true }))).toEqual({
      stripeCustomerId: false,
      signupGrantUnlockCount: false,
      signupInviteBonusCount: false,
    });
  });

  it('uses the passed-in organization collection name rather than a hardcoded literal', () => {
    expect(resolveFieldLimits('orgs_v2', opts({ organizationCollectionName: 'orgs_v2' }))).toEqual(
      memberOrganizationLimits
    );
  });

  it('drops invite recipients and the bearer token for a non-admin', () => {
    expect(resolveFieldLimits('invites', opts())).toEqual({
      token: false,
      recipients: false,
      typedRecipients: false,
    });
  });

  it('keeps invite recipients for a platform admin but never the token', () => {
    expect(resolveFieldLimits('invites', opts({ isPlatformAdmin: true }))).toEqual({ token: false });
  });
});

describe('findWithheldFilterPaths', () => {
  const inviteLimits = resolveFieldLimits('invites', opts());

  it('names a filter path equal to, under, or above a withheld path', () => {
    expect(findWithheldFilterPaths({ token: 'x' }, inviteLimits)).toEqual(['token']);
    expect(findWithheldFilterPaths({ 'recipients.pending': 'x' }, inviteLimits)).toEqual(['recipients.pending']);
    const questLimits = resolveFieldLimits('quests', opts());
    expect(findWithheldFilterPaths({ promptMeta: {} }, questLimits)).toEqual(['promptMeta']);
  });

  it('walks $and/$or/$nor', () => {
    expect(findWithheldFilterPaths({ $nor: [{ $and: [{ typedRecipients: 'x' }] }] }, inviteLimits)).toEqual([
      'typedRecipients',
    ]);
  });

  it('passes filters that touch nothing withheld, and every filter when nothing is withheld', () => {
    expect(findWithheldFilterPaths({ documentId: 'd', type: 'Project', recipientsCount: 1 }, inviteLimits)).toEqual([]);
    expect(findWithheldFilterPaths({ token: 'x' }, undefined)).toEqual([]);
    expect(
      findWithheldFilterPaths({ recipients: 'x' }, resolveFieldLimits('invites', opts({ isPlatformAdmin: true })))
    ).toEqual([]);
  });
});
