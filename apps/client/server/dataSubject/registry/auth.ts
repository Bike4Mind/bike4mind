import type { DataHolderRegistry } from '../types';

export const authHolders = {
  // Notes about a person are the platform's accountability record, so they outlive the person with the link cut.
  AdminUserNote: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'author.id', matchBy: 'userId', action: 'anonymize', alsoRedact: ['author.name'] },
      { path: 'editor.id', matchBy: 'userId', action: 'anonymize', alsoRedact: ['editor.name'] },
    ],
  },
  AdminUserNoteRevision: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'author.id', matchBy: 'userId', action: 'anonymize', alsoRedact: ['author.name'] },
      { path: 'editor.id', matchBy: 'userId', action: 'anonymize', alsoRedact: ['editor.name'] },
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
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  AuthFailLog: {
    kind: 'holder',
    references: [
      {
        path: 'email',
        matchBy: 'email',
        action: 'anonymize',
        alsoRedact: ['ip', 'username', 'userAgent', 'geo', 'device'],
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
  // The claim is what stops one GitHub account unlocking credits twice; deleting it would re-open that.
  GithubUnlockClaim: {
    kind: 'holder',
    references: [
      {
        path: 'userId',
        matchBy: 'userId',
        action: 'retain',
        reason: 'Anti-abuse claim keyed by GitHub account, kept to prevent repeat credit unlocks (legitimate interest)',
      },
    ],
  },
  IdentityProvider: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['samlConfig.decryptionPvk', 'samlConfig.privateCert', 'oktaConfig.clientSecret'],
    unrelatedPaths: ['emailDomain', 'samlConfig.attributeMappings.email'],
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
    secretPaths: ['nonce', 'codes.nonce', 'codes.otcHash', 'debugCode'],
  },
  // A chat message: it follows its notebook. The flagged paths are the notebook owner or free-text attribution.
  Quest: {
    kind: 'viaParent',
    parent: 'SessionModel',
    foreignKey: 'sessionId',
    unrelatedPaths: [
      'signupActivity.userId',
      'promptMeta.session.userId',
      'promptMeta.humanReview.reviewedBy',
      'promptMeta.citables.author',
      'attachmentList.attachments.author',
    ],
  },
  RegistrationInvite: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'usedbyId', matchBy: 'userId', action: 'anonymize' },
      { path: 'usageHistory.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'email', matchBy: 'email', action: 'anonymize' },
    ],
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
        reason: 'Financial record kept for accounting and tax obligations (GDPR Art. 17(3)(b))',
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
      },
      {
        path: 'email',
        matchBy: 'email',
        action: 'retain',
        reason: 'Signup-abuse signal kept for its 7-day expiry to detect coordinated signups (legitimate interest)',
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
  },
  // Who accessed whose account is an accountability record, so both sides are anonymized, not deleted.
  SupportAccess: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'adminId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  TrustedDevice: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['tokenHash'],
  },
  User: {
    kind: 'subject',
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
    references: [
      {
        path: 'userId',
        matchBy: 'userId',
        action: 'retain',
        reason: 'Fraud-detection score kept for its 30-day retention window to prevent abuse (legitimate interest)',
      },
    ],
  },
  Voice: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  WsConnectTicket: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['ticket'],
  },
} satisfies DataHolderRegistry;
