import type { IUser } from '../types/entities/UserTypes';
// SafeUser is inferred from the Zod response schema (RFC #483) so the serializer's
// output type and the parsed response contract can never drift apart. It is exported
// to the @bike4mind/common barrel from schemas/user, not re-exported here.
import { SELF_VIEW_PASSTHROUGH_FIELDS, type SafeUser } from '../schemas/user';
import { canAdministerOrganization, type AdministrableOrg, type OrgAuthorityActor } from '../constants/organization';

/**
 * Central boundary for serializing user records into API responses.
 *
 * SECURITY: sanitize at the response boundary, never at the model layer.
 * `BaseModel` repo methods return `toJSON()` and `req.user` is a shared full doc,
 * so a model-level `select:false`/`toJSON` strip would break internal readers
 * (auth.ts, SSO callbacks, OAuth refresh flows). Everything that returns a user
 * doc to a client MUST route it through here, or -- for aggregation `$lookup`s,
 * which ignore `select:false` entirely -- project off `SAFE_USER_LOOKUP_PROJECT`
 * (spread it and add only the extra non-secret fields a given consumer needs;
 * see `InboxModel.findByReceiverId`).
 */

/**
 * Fields that must NEVER be serialized to any client, including the user viewing
 * themselves. Some of these are whole objects that ALSO carry non-secret status
 * the settings UI needs (googleDrive/atlassianConnect/blogIntegration/slackSettings):
 * for self-view those must have their token SUBFIELDS redacted rather than the
 * whole object dropped -- see `USER_SUBFIELD_REDACTED_FIELDS` and
 * `redactUserSecretsForSelf`.
 */
export const USER_SECRET_FIELDS = [
  'password',
  'mfa',
  'totpLastStep',
  'oauthCredentials',
  'authProviders',
  'googleDrive',
  'atlassianConnect',
  'notionConnect',
  'blogIntegration',
  'slackSettings',
  'resetPasswordToken',
  'resetPasswordSentAt',
  'resetPasswordExpires',
  'emailVerificationToken',
  'emailVerificationSentAt',
  'emailVerificationExpires',
  'pendingEmailToken',
  'pendingEmailSentAt',
  'pendingEmailExpires',
  'pendingNotionOAuthNonce',
  'personaLoginCodeHash',
  'personaLoginCodeExpiresAt',
  'securityQuestions',
  'loginRecords',
  'signupMeta',
  'riskScore',
  'riskReviewAutoApproval',
  'riskReviewReopenedAt',
  'paymentRiskEventAt',
  'riskReviewAutoCheckedAt',
  'riskEvidence',
  // Automated holds carry the abuse evidence in `reason`; the user sees the accountState message instead.
  'interventionHolds',
  'freeCreditClaimEmail',
  'freeQuestStartId',
  'grantPackageId',
  'signupGrantAssessment',
  'userNotes',
  'throttle',
  'riskSignals',
  'signupLanding',
  'stripeCustomerId',
  // Server-side lease against an export racing account cleanup; never client state.
  'accountDataExportLease',
  'accountFilePurge',
  // The provider-facing end-user id: admin lookup only, never client state.
  'providerEndUserId',
] as const;

/**
 * The subset of `USER_SECRET_FIELDS` that are integration objects carrying
 * non-secret status the settings UI needs. `redactUserSecretsForSelf` redacts
 * their token SUBFIELDS instead of dropping the whole object; every other entry
 * in `USER_SECRET_FIELDS` is dropped entirely. Keep this a strict subset of
 * `USER_SECRET_FIELDS`.
 */
export const USER_SUBFIELD_REDACTED_FIELDS = [
  'authProviders',
  'mfa',
  'googleDrive',
  'atlassianConnect',
  'notionConnect',
  'blogIntegration',
  'slackSettings',
] as const;

/**
 * What `redactUserSecretsForSelf` drops from inside the `USER_SUBFIELD_REDACTED_FIELDS` objects, as
 * dotted paths. A caller that can only express a Mongo exclusion projection (the users WebSocket
 * subscription) cannot rebuild an object from an allowlist, so it withholds these instead. Anything
 * the redactor does not copy out of one of those objects belongs here. The "rebuild-block allowlists
 * stay pinned" tests in toSafeUser.test.ts and the User-schema check in
 * apps/client/server/websocket/dataSubscribeFieldLimits.test.ts fail when the two disagree, the latter
 * also when a field is added to an integration schema and classified in neither place.
 */
export const USER_SECRET_SUBFIELD_PATHS = [
  'mfa.totpSecret',
  'mfa.backupCodes',
  'mfa.pendingBackupCodes',
  'mfa.failedAttempts',
  'mfa.lastFailedAttempt',
  'mfa.lockedUntil',
  'googleDrive.accessToken',
  'googleDrive.refreshToken',
  'atlassianConnect.accessToken',
  'atlassianConnect.refreshToken',
  'atlassianConnect.expiresAt',
  'atlassianConnect.pendingSelectionExpiresAt',
  'notionConnect.accessToken',
  'notionConnect.botId',
  'notionConnect.owner',
  'blogIntegration.apiKey',
  'slackSettings.slackUserToken',
  'slackSettings.slackUserScopes',
  'slackSettings.lastUsedAgent',
  'authProviders.accessToken',
  'authProviders.refreshToken',
  'authProviders.samlNameId',
  'authProviders.samlSessionIndex',
  'authProviders.samlIdentityProviderId',
  'authProviders.oktaIdentityProviderId',
  'authProviders.encrypted',
] as const;

/**
 * Base Mongo `$project` for a user pulled in via an aggregation `$lookup` (which
 * ignores `select:false`). This is the public-safe field set; a consumer that
 * legitimately needs more (e.g. the inbox sender modal needs email/phone) spreads
 * this and adds those fields explicitly rather than hand-rolling a projection, so
 * the secret-excluding baseline stays in one place.
 */
export const SAFE_USER_LOOKUP_PROJECT: Record<string, 1> = {
  _id: 1,
  name: 1,
  username: 1,
  photoUrl: 1,
  isOnline: 1,
  lastActiveAt: 1,
};

/**
 * `org-member` is the names-only roster a plain org member sees: `public` plus `isBanned`, never email.
 * `same-org` is the full roster for whoever may administer the org. Pick between them with
 * `organizationRosterScope`, never by hand.
 */
export type SafeUserScope = 'public' | 'same-org' | 'org-member' | 'self';

// Accept anything user-doc-shaped (Mongoose doc, toJSON()'d object, or lean result).
type UserLike = (Partial<IUser> & { _id?: unknown }) | null | undefined;

/**
 * Whitelist-serialize a user for exposure to ANOTHER user. `public` returns
 * name/username/photo only; `self` adds email; `org-member` adds isBanned; `same-org` adds
 * email + isBanned.
 * For a user's OWN full profile (integration status, preferences, etc.) do NOT
 * use this -- use `redactUserSecretsForSelf`.
 */
export function toSafeUser(user: UserLike, scope: SafeUserScope = 'public'): SafeUser | null {
  if (!user) return null;
  const id = user.id ?? (user._id != null ? String(user._id) : '');
  const safe: SafeUser = {
    id,
    name: user.name as string,
    username: user.username as string,
    photoUrl: user.photoUrl ?? null,
    isOnline: user.isOnline,
    lastActiveAt: user.lastActiveAt,
  };
  if (scope === 'same-org' || scope === 'self') {
    safe.email = user.email ?? null;
  }
  if (scope === 'same-org' || scope === 'org-member') {
    // Org-member cards render a "Deactivated" chip from isBanned.
    safe.isBanned = user.isBanned ?? false;
  }
  return safe;
}

/**
 * The scope an org roster is serialized with for this viewer: the full roster (with emails) for the
 * owner, a current manager or a site admin (`canAdministerOrganization`), names only for anyone else.
 * Mirrors the `userDetails` contact strip in `toSafeOrganization`.
 */
export function organizationRosterScope(
  viewer: OrgAuthorityActor,
  organization: AdministrableOrg
): Extract<SafeUserScope, 'same-org' | 'org-member'> {
  return canAdministerOrganization(viewer, organization) ? 'same-org' : 'org-member';
}

/** Array convenience; drops null/undefined entries. */
export function toSafeUsers(users: UserLike[] | null | undefined, scope: SafeUserScope = 'public'): SafeUser[] {
  return (users ?? []).map(u => toSafeUser(u, scope)).filter((u): u is SafeUser => u !== null);
}

/**
 * Secret-list fields the SUBJECT of a profile may legitimately get back on a self view --
 * data that belongs to the user. Only these can be re-admitted via `keep`.
 */
export const SELF_KEEPABLE_SECRET_FIELDS = ['securityQuestions'] as const;
export type SelfKeepableSecretField = (typeof SELF_KEEPABLE_SECRET_FIELDS)[number];

/**
 * Secret-list fields that describe a user rather than belong to them: admin-authored notes
 * and login PII (IPs/userAgents). These are deliberately OUTSIDE `keep`, because `keep` is
 * chosen by the endpoint from the SUBJECT's point of view -- passing 'userNotes' there handed
 * every user the admin's private notes about them. Re-including one requires `keepAdminOnly`,
 * whose name is the reminder that the caller must have checked the VIEWER, not the subject.
 */
export const ADMIN_ONLY_USER_FIELDS = [
  'userNotes',
  'loginRecords',
  'signupMeta',
  'signupGrantAssessment',
  'throttle',
  'riskSignals',
] as const;
export type AdminOnlyUserField = (typeof ADMIN_ONLY_USER_FIELDS)[number];

/**
 * The fields `redactUserSecretsForSelf` copies as-is: those classified as self-visible
 * (SELF_VIEW_PASSTHROUGH_FIELDS in schemas/user.ts, which the compiler holds to IUser), plus the
 * `_id` that toJSON() emits.
 */
const SELF_VIEW_COPIED_FIELDS = [...Object.keys(SELF_VIEW_PASSTHROUGH_FIELDS), '_id'];

/**
 * Redact secrets from the caller's OWN full profile (self-view endpoints such as
 * users/[id] self and users/[id]/update). Like `toSafeUser` it is an allowlist, but a
 * broad one: every field classified as self-visible, plus SUBFIELD allowlists for the
 * integration objects so the settings UI keeps the non-secret status it depends on
 * (connection state, workspace/site name, baseUrl, etc.). Returns a plain object for
 * serialization.
 *
 * Keep-lists per integration confirmed with product.
 */
export function redactUserSecretsForSelf(
  input: Partial<IUser> | null | undefined,
  options?: {
    keep?: readonly SelfKeepableSecretField[];
    /** Admin-only fields to re-include. Set ONLY after confirming the VIEWER is an admin. */
    keepAdminOnly?: readonly AdminOnlyUserField[];
  }
): Record<string, unknown> | null {
  if (!input) return null;
  // Accept a Mongoose document OR a plain/toJSON()'d object. Spreading a hydrated
  // Mongoose doc yields internals, not fields, so normalize to a plain object first.
  const user: Partial<IUser> =
    typeof (input as { toJSON?: unknown }).toJSON === 'function'
      ? (input as { toJSON: () => Partial<IUser> }).toJSON()
      : input;
  // Allowlist: a field nobody classified never leaves here. The integration objects below are
  // rebuilt from their own allowlists.
  const u: Record<string, unknown> = {};
  for (const f of SELF_VIEW_COPIED_FIELDS) {
    if (Object.hasOwn(user, f)) u[f] = (user as Record<string, unknown>)[f];
  }

  // MFA -> keep enrollment status, drop the secret + backup codes.
  if (user.mfa) {
    u.mfa = {
      totpEnabled: user.mfa.totpEnabled,
      passkeyEnabled: user.mfa.passkeyEnabled,
      setupAt: user.mfa.setupAt,
      lastUsedAt: user.mfa.lastUsedAt,
    };
  }
  // Google Drive -> keep only the expiry as a "connected" signal.
  if (user.googleDrive) {
    u.googleDrive = { expiresAt: user.googleDrive.expiresAt };
  }
  // Atlassian -> keep site/status metadata, drop the tokens.
  if (user.atlassianConnect) {
    const a = user.atlassianConnect;
    u.atlassianConnect = {
      siteName: a.siteName,
      resources: a.resources,
      status: a.status,
      connectedAt: a.connectedAt,
      selectedResourceId: a.selectedResourceId,
      disconnectReason: a.disconnectReason,
    };
  }
  // Notion -> keep workspace/status metadata, drop the token.
  if (user.notionConnect) {
    const n = user.notionConnect;
    u.notionConnect = {
      workspaceId: n.workspaceId,
      workspaceName: n.workspaceName,
      workspaceIcon: n.workspaceIcon,
      status: n.status,
      writeEnabled: n.writeEnabled,
      accessMode: n.accessMode,
      allowedPages: n.allowedPages,
      excludedPageIds: n.excludedPageIds,
      rootPageId: n.rootPageId,
      connectedAt: n.connectedAt,
      disconnectReason: n.disconnectReason,
    };
  }
  // Slack -> allowlist, like every other block here, so a field added to the
  // settings type (it already carries slackUserToken/slackUserScopes/lastUsedAgent)
  // does not reach the browser until named on purpose. These are exactly the fields
  // the settings UI reads, and exactly the ones SlackSettingsSchema accepts on write
  // (pages/api/users/[id]/slack-settings.ts) -- keep the two in sync, or the UI saves
  // a value it can never read back and drops it on the next round-trip.
  if (user.slackSettings) {
    const s = user.slackSettings;
    u.slackSettings = {
      slackUserId: s.slackUserId,
      slackTeamId: s.slackTeamId,
      defaultNotebookId: s.defaultNotebookId,
      autoCreateNotebook: s.autoCreateNotebook,
      notebookNamePrefix: s.notebookNamePrefix,
      defaultProjectId: s.defaultProjectId,
      agentNotebookRouting: s.agentNotebookRouting,
      keywordRouting: s.keywordRouting,
      customAgentId: s.customAgentId,
      githubNotifications: s.githubNotifications,
    };
  }
  // Auth providers -> allowlist, like every other block here, so a field added to the
  // provider type (it already carries samlNameId/samlSessionIndex/oktaIdentityProviderId/
  // encrypted) does not reach the browser until named on purpose. The settings UI
  // (ConnectedAppsSection) reads only `strategy`; `id` is kept as a stable identity.
  // An array, unlike every other entry here, so map rather than reshape once.
  if (user.authProviders) {
    u.authProviders = user.authProviders.map(provider => ({ id: provider.id, strategy: provider.strategy }));
  }
  // Blog -> keep display/config, drop the API key.
  if (user.blogIntegration) {
    const b = user.blogIntegration;
    u.blogIntegration = {
      baseUrl: b.baseUrl,
      defaultAuthor: b.defaultAuthor,
      defaultTags: b.defaultTags,
      connectedAt: b.connectedAt,
    };
  }

  // Opt-in: re-include specific secret-list fields for a tightly-scoped caller that
  // legitimately needs them (the profile-edit endpoint round-trips securityQuestions).
  // The membership test is enforced at runtime as well as in the type: this is a
  // disclosure boundary, and a `as` cast at a call site must not be able to widen it.
  for (const f of options?.keep ?? []) {
    if (!SELF_KEEPABLE_SECRET_FIELDS.includes(f)) continue;
    if (f === 'securityQuestions' && Array.isArray(user.securityQuestions)) {
      u.securityQuestions = user.securityQuestions.map(({ question }) => ({ question, answer: '' }));
    }
  }

  // The grant stays visible to its holder (the signup credits UI reads it), but an admin's block is not.
  if (user.signupGrant?.blocked) {
    const { blocked: _blocked, ...grant } = user.signupGrant;
    u.signupGrant = grant;
  }

  // Separate door for the admin-only fields, so a viewer check is required to open it.
  for (const f of options?.keepAdminOnly ?? []) {
    if (!ADMIN_ONLY_USER_FIELDS.includes(f)) continue;
    if (user[f] !== undefined) u[f] = user[f];
  }

  return u;
}
