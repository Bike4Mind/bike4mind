import type { DataHolderRegistry } from '../types';
import { ADMIN_NOTE, FINANCIAL_RECORD, expiresAfterTtl } from './retention';

export const authHolders = {
  // Notes about the person go with them: the account purge removes them through the raw collection,
  // past the model's immutability hooks. A note this person wrote or edited as an admin about someone
  // else is that other account's record, and its identity fields are required and immutable, so it stays.
  AdminUserNote: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'author.id', matchBy: 'userId', action: 'retain', ...ADMIN_NOTE },
      { path: 'editor.id', matchBy: 'userId', action: 'retain', ...ADMIN_NOTE },
    ],
  },
  AdminUserNoteRevision: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'author.id', matchBy: 'userId', action: 'retain', ...ADMIN_NOTE },
      { path: 'editor.id', matchBy: 'userId', action: 'retain', ...ADMIN_NOTE },
    ],
  },
  ApiKey: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['apiKey'],
  },
  ApiKeyAlert: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['metadata.ipAddress'] }],
  },
  ApiKeyUsageLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['ipAddress'] }],
  },
  // The person's own sign-in trail: no accountability purpose for anyone else, so it goes with them.
  AuthEvent: {
    kind: 'holder',
    // The signup-abuse traces it keeps would go with the rows otherwise.
    beforeErasure: ['retainDeletedSignupTraces'],
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  AuthFailLog: {
    kind: 'holder',
    references: [
      {
        path: 'email',
        matchBy: 'email',
        action: 'anonymize',
        alsoRedact: ['ip', 'username', 'userAgent', 'geo', 'device', 'headers'],
      },
    ],
  },
  AuthSession: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      // The admin who impersonated is recorded on the impersonated person's session.
      { path: 'impersonatedBy', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: [
      'sid',
      'refreshTokenHash',
      'previousRefreshTokenHash',
      'stepUpEmailChallenge.tokenHash',
      'stepUpEmailChallenge.codeHash',
    ],
  },
  BlockedIP: {
    kind: 'holder',
    references: [{ path: 'blockedById', matchBy: 'userId', action: 'anonymize', alsoRedact: ['blockedByName'] }],
  },
  CcBridgeDevice: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  CcBridgePairingToken: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['tokenHash', 'tokenPrefix'],
  },
  DeviceAuthorization: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['deviceCode', 'userCode'],
  },
  DisposableDomain: { kind: 'noUserData', note: 'Catalogue of throwaway email domains.' },
  DisposableDomainSource: { kind: 'noUserData', note: 'Sync status of the disposable-domain feeds.' },
  DomainIntelligence: { kind: 'noUserData', note: 'Cached DNS/MX lookups keyed by email domain, not by person.' },
  ErasureRecord: {
    kind: 'pseudonymous',
    note: 'The erasure ledger: a keyed hash of an erased account id, kept so a restore from backup can re-apply the erasure.',
    // Who started the erasure ('admin', 'self', 'backfill'), not an id.
    unrelatedPaths: ['initiatedBy'],
  },
  IdentityProvider: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['samlConfig.decryptionPvk', 'samlConfig.privateCert', 'oktaConfig.clientSecret'],
    unrelatedPaths: ['emailDomain', 'samlConfig.attributeMappings.email', 'samlConfig.attributeMappings.username'],
  },
  OAuthAuthorizationCode: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['code', 'codeChallenge', 'nonce'],
  },
  OAuthClient: {
    kind: 'noUserData',
    note: 'Registered OAuth client applications; no person is recorded on them.',
  },
  OAuthGrant: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  OAuthRefreshToken: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['tokenHash'],
  },
  PartnerSignupRule: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  PasskeyChallenge: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['challenge'],
  },
  PasskeyCredential: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['publicKey'],
  },
  PendingOtcToken: {
    kind: 'holder',
    references: [{ path: 'email', matchBy: 'email', action: 'deleteDocument' }],
    // `codes.riskSignals` is abuse scoring; exporting it would show an attacker which signals tripped.
    secretPaths: ['nonce', 'codes.nonce', 'codes.otcHash', 'codes.riskSignals', 'debugCode'],
  },
  PushToken: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['token', 'sid'],
  },
  // A chat message: it follows its notebook. The flagged paths are the notebook owner or free-text attribution.
  Quest: {
    kind: 'viaParent',
    parent: 'SessionModel',
    foreignKey: 'sessionId',
    attribution: [
      { path: 'signupActivity.userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'promptMeta.session.userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'promptMeta.humanReview.reviewedBy', matchBy: 'userId', action: 'anonymize' },
    ],
    // Authors of cited works and attachments, not platform users.
    unrelatedPaths: ['promptMeta.citables.author', 'attachmentList.attachments.author'],
    // `signupActivity` is a retired field: never exported, though its `userId` is still anonymized.
    secretPaths: ['callback.url', 'signupActivity'],
  },
  RegistrationInvite: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'usedbyId', matchBy: 'userId', action: 'anonymize' },
      { path: 'usageHistory.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'email', matchBy: 'email', action: 'anonymize' },
    ],
    // A usable invite code admits whoever holds it.
    secretPaths: ['code'],
  },
  SamlRequestId: { kind: 'noUserData', note: 'Short-lived SAML request-id replay cache; no person is recorded.' },
  // Chat notebooks are the person's own content. A notebook shared with others goes with its owner.
  SessionModel: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
      // The payer of a live voice hold; only ever set while a voice session is running.
      { path: 'voiceHoldUserId', matchBy: 'userId', action: 'anonymize' },
    ],
    unrelatedPaths: [
      'conversationContext.github.repos.owner',
      'conversationContext.github.prs.owner',
      'conversationContext.github.issues.owner',
      // Which code owns a tutorial walk ('core'), not a person.
      'tutorial.owner',
    ],
  },
  SignupDomainReview: {
    kind: 'holder',
    references: [
      { path: 'cohortUserIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'sampleEmails', matchBy: 'email', action: 'pullFromArray' },
      { path: 'reviewedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  SignupGrantBudgetDay: { kind: 'noUserData', note: 'Daily signup-credit budget counters; aggregate only.' },
  SignupGrantReleaseBatch: {
    kind: 'holder',
    references: [
      { path: 'actorId', matchBy: 'userId', action: 'anonymize' },
      {
        path: 'entries.userId',
        matchBy: 'userId',
        action: 'retain',
        ...FINANCIAL_RECORD,
      },
    ],
  },
  SignupObservation: {
    kind: 'holder',
    references: [
      {
        path: 'userId',
        matchBy: 'userId',
        action: 'retain',
        reason: 'Signup-abuse signal kept for its 7-day expiry to detect coordinated signups (legitimate interest)',
        retention: expiresAfterTtl('verifiedAt', 7),
      },
      {
        path: 'email',
        matchBy: 'email',
        action: 'retain',
        reason: 'Signup-abuse signal kept for its 7-day expiry to detect coordinated signups (legitimate interest)',
        retention: expiresAfterTtl('verifiedAt', 7),
      },
    ],
  },
  SignupTrace: {
    kind: 'pseudonymous',
    note: 'Keyed only by one-way hashes of the account, IP and prefix; it cannot be resolved to a person by id.',
  },
  Subscriber: {
    kind: 'holder',
    references: [
      { path: 'email', matchBy: 'email', action: 'deleteDocument' },
      { path: 'inviteGeneratedBy', matchBy: 'userId', action: 'anonymize' },
    ],
    // A usable invite code admits whoever holds it.
    secretPaths: ['inviteCode'],
  },
  // Who accessed whose account is an accountability record, so both sides are anonymized, not deleted.
  SupportAccess: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'adminId', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: ['sid'],
    unmatchedPaths: {
      reason: "The admin's free-text reason for the access; it may name the person but is not matched to them.",
      escalationReason:
        "The admin's free-text reason for escalating; it may name the person but is not matched to them.",
    },
  },
  TrustedDevice: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['tokenHash'],
  },
  User: {
    kind: 'subject',
    references: [
      { path: 'referredByUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'throttle.changedBy', matchBy: 'userId', action: 'anonymize' },
      // The notebook owner whose shared page this account signed up from.
      { path: 'signupLanding.notebookOwnerId', matchBy: 'userId', action: 'anonymize' },
    ],
    // Declared `ref: 'User'`, but `recordReferrals` stores the ids of the invites this user created.
    unrelatedPaths: ['regInvites'],
    secretPaths: [
      'password',
      'mfa.totpSecret',
      'mfa.backupCodes',
      'mfa.pendingBackupCodes',
      'totpLastStep',
      'oauthCredentials',
      'securityQuestions.answer',
      'authProviders.accessToken',
      'authProviders.refreshToken',
      'authProviders.samlSessionIndex',
      'googleDrive.accessToken',
      'googleDrive.refreshToken',
      'atlassianConnect.accessToken',
      'atlassianConnect.refreshToken',
      'notionConnect.accessToken',
      'slackSettings.slackUserToken',
      'blogIntegration.apiKey',
      'pendingNotionOAuthNonce',
      'resetPasswordToken',
      'emailVerificationToken',
      'pendingEmailToken',
    ],
  },
  UserActivityCounter: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  UserApiKey: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'revokedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'metadata.createdByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: ['keyHash', 'keyDigest', 'callbackSigningSecret'],
  },
  UserApiKeyAuditLog: {
    kind: 'holder',
    references: [
      { path: 'actorUserId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorIp', 'actorUserAgent'] },
    ],
  },
  UserAuthAuditLog: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorIp', 'userAgent'] },
      { path: 'actorUserId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorIp', 'userAgent'] },
    ],
  },
  UserUsagePatternSignals: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Voice: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  WsConnectTicket: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['ticket', 'sid'],
  },
} satisfies DataHolderRegistry;
