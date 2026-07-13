import type { IUser } from '../types/entities/UserTypes';

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
  'securityQuestions',
  'loginRecords',
  'userNotes',
  'stripeCustomerId',
] as const;

/**
 * The subset of `USER_SECRET_FIELDS` that are integration objects carrying
 * non-secret status the settings UI needs. `redactUserSecretsForSelf` redacts
 * their token SUBFIELDS instead of dropping the whole object; every other entry
 * in `USER_SECRET_FIELDS` is dropped entirely. Keep this a strict subset of
 * `USER_SECRET_FIELDS`.
 */
export const USER_SUBFIELD_REDACTED_FIELDS = [
  'mfa',
  'googleDrive',
  'atlassianConnect',
  'notionConnect',
  'blogIntegration',
  'slackSettings',
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

export type SafeUserScope = 'public' | 'same-org' | 'self';

export type SafeUser = Pick<IUser, 'id' | 'name' | 'username' | 'photoUrl' | 'isOnline' | 'lastActiveAt'> & {
  email?: string | null;
};

// Accept anything user-doc-shaped (Mongoose doc, toJSON()'d object, or lean result).
type UserLike = (Partial<IUser> & { _id?: unknown }) | null | undefined;

/**
 * Whitelist-serialize a user for exposure to ANOTHER user. `public` returns
 * name/username/photo only; `same-org` and `self` additionally include email.
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
  return safe;
}

/** Array convenience; drops null/undefined entries. */
export function toSafeUsers(users: UserLike[] | null | undefined, scope: SafeUserScope = 'public'): SafeUser[] {
  return (users ?? []).map(u => toSafeUser(u, scope)).filter((u): u is SafeUser => u !== null);
}

/**
 * Redact secrets from the caller's OWN full profile (self-view endpoints such as
 * users/[id] self and users/[id]/update). Unlike `toSafeUser` (an allowlist for
 * OTHER users), this keeps the broad self-profile but strips secrets: whole-drop
 * for pure-secret fields, and SUBFIELD redaction for the integration objects so
 * the settings UI keeps the non-secret status it depends on (connection state,
 * workspace/site name, baseUrl, etc.). Returns a plain object for serialization.
 *
 * Keep-lists per integration confirmed with product.
 */
export function redactUserSecretsForSelf(
  input: Partial<IUser> | null | undefined,
  options?: { keep?: readonly (keyof IUser)[] }
): Record<string, unknown> | null {
  if (!input) return null;
  // Accept a Mongoose document OR a plain/toJSON()'d object. Spreading a hydrated
  // Mongoose doc yields internals, not fields, so normalize to a plain object first.
  const user: Partial<IUser> =
    typeof (input as { toJSON?: unknown }).toJSON === 'function'
      ? (input as { toJSON: () => Partial<IUser> }).toJSON()
      : input;
  const u: Record<string, unknown> = { ...user };

  // Drop EVERY secret field first, then rebuild the non-secret status subset for the
  // integration objects below. Dropping all up front (rather than skipping the
  // integrations) guarantees that a secret added to USER_SECRET_FIELDS without a
  // matching rebuild block is dropped WHOLE -- a visible missing-status bug, never a
  // silent secret exposure. USER_SUBFIELD_REDACTED_FIELDS names the ones that ARE rebuilt.
  for (const f of USER_SECRET_FIELDS) delete u[f];

  // MFA -> keep enrollment status, drop the secret + backup codes.
  if (user.mfa) {
    u.mfa = { totpEnabled: user.mfa.totpEnabled, setupAt: user.mfa.setupAt, lastUsedAt: user.mfa.lastUsedAt };
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
      rootPageId: n.rootPageId,
      connectedAt: n.connectedAt,
      disconnectReason: n.disconnectReason,
    };
  }
  // Slack -> keep everything except the user token.
  if (user.slackSettings) {
    const { slackUserToken: _drop, ...rest } = user.slackSettings;
    u.slackSettings = rest;
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
  // legitimately needs them (e.g. the self/admin profile-edit endpoint round-trips
  // securityQuestions/userNotes). Intended for non-integration fields, never tokens.
  for (const f of options?.keep ?? []) {
    if (user[f] !== undefined) u[f] = user[f];
  }

  return u;
}
