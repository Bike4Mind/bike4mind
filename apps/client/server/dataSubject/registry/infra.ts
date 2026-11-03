import type { DataHolderRegistry } from '../types';

export const infraHolders = {
  AdminAuditAlertState: {
    kind: 'holder',
    references: [{ path: 'openBursts.actorUserId', matchBy: 'userId', action: 'pullFromArray' }],
  },
  // Accountability log: the entry stays, the identity link goes. Free-text `summary`, `changes` and `details` are
  // not scanned for the person.
  AdminAuditLog: {
    kind: 'holder',
    references: [
      {
        path: 'actor.userId',
        matchBy: 'userId',
        action: 'anonymize',
        alsoRedact: ['actor.email', 'actor.name', 'context.ip', 'context.userAgent'],
      },
      { path: 'actor.impersonatedUserId', matchBy: 'userId', action: 'anonymize' },
      {
        path: 'target.id',
        matchBy: 'userId',
        action: 'anonymize',
        alsoRedact: ['target.displayName'],
        where: { 'target.kind': 'user' },
      },
    ],
    unrelatedPaths: ['actor.email'],
  },
  AdminSavedView: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  AdminSettings: { kind: 'noUserData', note: 'Platform configuration; secret values are encrypted at rest.' },
  AdminSupportAccessAuditLog: {
    kind: 'holder',
    references: [
      {
        path: 'actorUserId',
        matchBy: 'userId',
        action: 'anonymize',
        alsoRedact: ['actorIp', 'actorUserAgent', 'actorApiKeyId'],
      },
      { path: 'targetUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  BusinessMetricState: { kind: 'noUserData', note: 'Platform metric sampling state; `subscribers` is a count.' },
  // Keys embed user ids (`rate-limit:<userId>:<route>`) but a key is one opaque string with no field to match on, and
  // every row expires on its TTL.
  Cache: {
    kind: 'noUserData',
    note: 'Short-lived dedupe, lease and rate-limit entries keyed by an opaque string; rows expire on their TTL.',
  },
  // Activity counters behind platform metrics: the row stays for the aggregates, the person's identity goes.
  CounterLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['userName'] }],
  },
  Counters: { kind: 'noUserData', note: 'Platform-wide named counters.' },
  // `messageBody` is the replayed queue message and may carry user content; it is not scanned.
  DlqReplayLog: {
    kind: 'holder',
    references: [{ path: 'replayedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  EmailJob: {
    kind: 'holder',
    references: [
      { path: 'createdBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'startedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'lastSentBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'recipientFilter.userIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'recipientFilter.specificEmails', matchBy: 'email', action: 'pullFromArray' },
      { path: 'testEmailAddresses', matchBy: 'email', action: 'pullFromArray' },
    ],
    unrelatedPaths: ['totalEmailsSent'],
  },
  EmailPreferences: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'email', matchBy: 'email', action: 'deleteDocument' },
    ],
    secretPaths: ['unsubscribeToken'],
  },
  // A delivered message is the recipient's own data. Rows for a `subscriber` or `direct` recipient carry no user id,
  // so they are found by address.
  EmailSendAttempt: {
    kind: 'holder',
    references: [
      { path: 'recipientId', matchBy: 'userId', action: 'deleteDocument', where: { recipientType: 'user' } },
      { path: 'recipientEmail', matchBy: 'email', action: 'deleteDocument' },
      { path: 'originalRecipient', matchBy: 'email', action: 'deleteDocument' },
      { path: 'sentBy', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: ['trackingToken'],
    unrelatedPaths: ['isTestEmail'],
  },
  EmailTemplate: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  FallbackLakeSetting: { kind: 'noUserData', note: 'Per-lake grounding settings; no user reference.' },
  GitHubLakeAuthGrant: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['nonceHash', 'encryptedToken'],
  },
  HelpEvent: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // The person's own mailbox. Third-party addresses in from/to/cc/bcc go with the document.
  IngestedEmail: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'sharedWithUsers', matchBy: 'userId', action: 'pullFromArray' },
    ],
    unrelatedPaths: ['platformEmailAddress', 'rawEmailS3Key'],
  },
  IntegrationAuditLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['sourceIp', 'userAgent'] }],
  },
  IntegrationCircuitOverride: {
    kind: 'holder',
    references: [{ path: 'setBy', matchBy: 'userId', action: 'anonymize' }],
  },
  IntegrationHealthCheck: { kind: 'noUserData', note: 'Platform health probe results per integration.' },
  IntegrationRequest: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // Staff roster keyed by address, with no user id.
  InternalTeamMember: {
    kind: 'holder',
    references: [{ path: 'email', matchBy: 'email', action: 'deleteDocument' }],
  },
  JiraWebhookConfig: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['routingToken', 'secret', 'previousSecret'],
  },
  // Delivery log of the person's own subscription; `payload` holds the Jira event and goes with it.
  JiraWebhookDelivery: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['slackWebhookUrl'],
  },
  JiraWebhookSubscription: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  LakeConnectorClaim: { kind: 'noUserData', note: 'Uniqueness claim tying a lake to a connection.' },
  LiveopsTriageConfig: {
    kind: 'noUserData',
    note: 'Platform ops configuration.',
    unrelatedPaths: ['githubOwner'],
  },
  LiveopsTriageConfigAuditLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['userName'] }],
  },
  LiveopsTriageRun: { kind: 'noUserData', note: 'Platform triage run status.' },
  MarketingReport: {
    kind: 'holder',
    references: [
      {
        path: 'createdByUserId',
        matchBy: 'userId',
        action: 'anonymize',
        alsoRedact: ['createdByName', 'createdByApiKeyId', 'createdByKeyName'],
      },
    ],
  },
  MarketingReportRead: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Migration: { kind: 'noUserData', note: 'Database migration bookkeeping.' },
  OrgGitHubConnection: {
    kind: 'holder',
    references: [
      { path: 'connectedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'suspendedBy', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: ['privateKey', 'cachedAccessToken', 'accessToken'],
  },
  OrgGitHubLakeConnection: {
    kind: 'holder',
    references: [{ path: 'connectedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  OrgGoogleDriveConnection: {
    kind: 'holder',
    references: [{ path: 'connectedBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['oauthRefreshToken', 'ingestClaimToken'],
  },
  OrgJiraConnection: {
    kind: 'holder',
    references: [{ path: 'connectedBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['accessToken'],
  },
  OrgSlackWorkspace: {
    kind: 'holder',
    references: [{ path: 'installedBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['slackBotToken'],
    unrelatedPaths: ['slackBotUserId'],
  },
  OrgWebhookConfig: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['routingToken', 'secret'],
  },
  // `userId` is the owner, but the schema cannot tell a personal organization from a team one, and deleting a team
  // organization would remove its members' workspace. So the owner link is anonymized; deleting a personal
  // organization belongs to the erasure flow, which can see the member count.
  // `userDetails.email` and `.name` are removed with the element that `userDetails.id` pulls.
  Organization: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'adminUserIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'userDetails.id', matchBy: 'userId', action: 'pullFromArray' },
    ],
    unrelatedPaths: ['userDetails.email'],
  },
  OverwatchProduct: { kind: 'noUserData', note: 'Tracked product catalogue entry.' },
  // The event `userId` is an HMAC of the Bike4Mind user id under a server-side salt (`pseudonymizeUserId`), not the id.
  OverwatchRawEvent: {
    kind: 'pseudonymous',
    note: 'Product analytics event keyed by a salted HMAC of the user id; kept for retention and funnel history.',
    unrelatedPaths: ['userId'],
  },
  OverwatchRollup: { kind: 'noUserData', note: 'Daily active-user counts per product.' },
  OverwatchSeenEvent: { kind: 'noUserData', note: 'Event-id dedupe marker.' },
  OverwatchUserDay: {
    kind: 'pseudonymous',
    note: 'Daily active marker keyed by a salted HMAC of the user id; kept for retention history.',
    unrelatedPaths: ['userId'],
  },
  OverwatchUserFirstSeen: {
    kind: 'pseudonymous',
    note: 'First-seen marker keyed by a salted HMAC of the user id; kept for retention history.',
    unrelatedPaths: ['userId'],
  },
  QaRun: { kind: 'noUserData', note: 'CI test run summary.' },
  QaTestResult: { kind: 'noUserData', note: 'CI test case result.' },
  RateLimitSnapshot: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize' }],
  },
  // Only `scopeLevel: 'owner'` rows address a person; organization and lake rows are addressed by their own ids.
  ScopedSetting: {
    kind: 'holder',
    references: [
      {
        path: 'scopeId',
        matchBy: 'userId',
        action: 'deleteDocument',
        where: { scopeLevel: 'owner', ownerType: 'User' },
      },
    ],
  },
  SecretRotation: {
    kind: 'holder',
    references: [
      { path: 'lastRotatedById', matchBy: 'userId', action: 'anonymize', alsoRedact: ['lastRotatedByName'] },
    ],
    secretPaths: ['previousKey'],
  },
  SecurityDashboardSnapshot: { kind: 'noUserData', note: 'Platform security scan results.' },
  SecurityFinding: { kind: 'noUserData', note: 'Platform security probe finding.' },
  SecurityFindingRun: { kind: 'noUserData', note: 'Platform security probe run summary.' },
  SecurityScanSchedule: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  // A fraud-detection record naming several accounts and a network: kept to prevent repeat abuse, so the reviewer
  // verdicts are anonymized but `userIds` and `network` are not removed.
  ShadowDetection: {
    kind: 'holder',
    references: [
      {
        path: 'userIds',
        matchBy: 'userId',
        action: 'retain',
        reason: 'Fraud signal kept for the legitimate interest in preventing repeat abuse (GDPR Art. 6(1)(f))',
      },
      { path: 'verdicts.reviewerId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  SlackAuditLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['slackUserId', 'ipAddress'] }],
    unrelatedPaths: ['slackUserId'],
  },
  SlackChannelConfig: {
    kind: 'holder',
    references: [{ path: 'configuredBy', matchBy: 'userId', action: 'anonymize' }],
    unrelatedPaths: ['githubOwner'],
  },
  SlackDevWorkspace: {
    kind: 'noUserData',
    note: 'Platform development Slack workspace; credentials are encrypted at rest.',
    unrelatedPaths: ['slackBotUserId'],
  },
  SlackExportJob: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['downloadUrl'],
  },
  SreErrorPattern: { kind: 'noUserData', note: 'Learned error diagnosis pattern.' },
  // `fixVerdict.by` is a GitHub login of a staff reviewer, not a Bike4Mind user reference.
  SreErrorTracking: {
    kind: 'holder',
    references: [
      { path: 'affectedUserIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'dismissedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  StorageDriftRecord: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  SystemSecret: {
    kind: 'holder',
    references: [{ path: 'lastModifiedBy', matchBy: 'userId', action: 'anonymize' }],
    secretPaths: ['encryptedValue', 'previousEncryptedValue'],
  },
  TaskSchedule: { kind: 'noUserData', note: 'Queued job handler and payload; transient, expires on `expireAt`.' },
  // The cached teammates are GitHub contributors, not Bike4Mind users; they go with the owner's cache.
  TeamMetricsCache: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  TelemetryAuditLog: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['userEmail', 'sourceIp', 'userAgent'] },
    ],
    unrelatedPaths: ['userEmail'],
  },
  TelemetryDryRunResult: { kind: 'noUserData', note: 'Telemetry triage dry-run output; no user reference.' },
  // `sender` is the GitHub login that triggered the event, which cannot be resolved to a Bike4Mind user.
  WebhookAuditLog: {
    kind: 'noUserData',
    note: 'Inbound GitHub webhook log; `sender` is a third-party GitHub login.',
    unrelatedPaths: ['sender'],
  },
  WebhookDelivery: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['targetUrl'],
  },
  WebhookSubscription: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
} satisfies DataHolderRegistry;
