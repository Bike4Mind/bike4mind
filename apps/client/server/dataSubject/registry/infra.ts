import type { DataHolderRegistry } from '../types';
import { AUDIT_LOG, EMAIL_SUPPRESSION, expiresAfterTtl } from './retention';

export const infraHolders = {
  // A frozen evaluation set of accounts for measuring abuse detection. Account deletion
  // (abuseEvalSetRepository.removeUser) pulls the person's own example, with its verdicts, from every set.
  // Campaign keys are opaque hashes, so no other example names the person. The admin references below
  // are classified for export; deletion does not rewrite them.
  AbuseEvalSet: {
    kind: 'holder',
    references: [
      { path: 'examples.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'createdBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'examples.verdicts.reviewerId', matchBy: 'userId', action: 'anonymize' },
      { path: 'runs.ranBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  // Advisory model judgment of a shadow detection, kept for as long as the detection.
  AbuseAssessment: {
    kind: 'viaParent',
    parent: 'ShadowDetection',
    foreignKey: 'detectionId',
    attribution: [{ path: 'requestedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  // Advisory model verdict on an admin queue item. `entityId` is that item (a detection, a ticket), not a
  // person, and evidence is pseudonymised before it is stored; the deciding admin is the only reference.
  // `overrideReason` is the admin's free text and is not scanned.
  AdminAiSuggestion: {
    kind: 'holder',
    references: [{ path: 'decidedBy.userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['decidedBy.name'] }],
  },
  AdminAiAttempt: {
    kind: 'noUserData',
    note: 'Platform AI call accounting and outcome metadata; suggestionId links a suggestion, not a user account.',
  },
  AdminAiClass: {
    kind: 'noUserData',
    note: 'Operator-maintained action-class modes and aggregate replay evidence; replayArtifact is free text and is not scanned.',
  },
  AdminMorningBrief: {
    kind: 'noUserData',
    note: 'Environment/day operational counts, alarm names, aggregate AI activity and admin page links; no user references or source queue content are stored.',
  },
  // An admin's request for a second admin's sign-off on a privileged action, kept with the audit trail.
  // `summary` and `paramsJson` (which may name the target account) are free text and not scanned, so
  // both admins are actors on it: their export carries only their own reference.
  AdminApproval: {
    kind: 'holder',
    references: [
      {
        path: 'requestedBy.id',
        matchBy: 'userId',
        action: 'retain',
        ...AUDIT_LOG,
        identifies: ['requestedBy.name'],
        exportScope: 'reference',
      },
      {
        path: 'requestedBy.selfIds',
        matchBy: 'userId',
        action: 'retain',
        ...AUDIT_LOG,
        exportScope: 'reference',
      },
      {
        path: 'requestedBy.email',
        matchBy: 'email',
        action: 'retain',
        ...AUDIT_LOG,
        exportScope: 'reference',
      },
      {
        path: 'decidedBy.id',
        matchBy: 'userId',
        action: 'retain',
        ...AUDIT_LOG,
        identifies: ['decidedBy.name'],
        exportScope: 'reference',
      },
    ],
  },
  AdminAuditAlertState: {
    kind: 'holder',
    references: [{ path: 'openBursts.actorUserId', matchBy: 'userId', action: 'pullFromArray' }],
  },
  OrgAdminNotificationPref: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // Per-period alert dedup rows; only an alert about one person names them, and its scope repeats the id.
  OrgAlertNotification: {
    kind: 'holder',
    references: [{ path: 'subjectUserId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  OrganizationAuditEvent: {
    kind: 'holder',
    references: [
      { path: 'actorUserId', matchBy: 'userId', action: 'retain', ...AUDIT_LOG },
      { path: 'targetId', matchBy: 'userId', action: 'retain', ...AUDIT_LOG, where: { action: 'member.added' } },
      { path: 'targetId', matchBy: 'userId', action: 'retain', ...AUDIT_LOG, where: { action: 'member.removed' } },
    ],
  },
  // Append-only: the model rejects every update, so the entry cannot be anonymized in place. Free-text `summary`,
  // `changes` and `details` are not scanned for the person.
  AdminAuditLog: {
    kind: 'holder',
    references: [
      {
        path: 'actor.userId',
        matchBy: 'userId',
        action: 'retain',
        ...AUDIT_LOG,
        identifies: ['actor.email', 'actor.name', 'actor.apiKeyId', 'context.ip', 'context.userAgent'],
        exportScope: 'reference',
      },
      {
        path: 'actor.impersonatedUserId',
        matchBy: 'userId',
        action: 'retain',
        ...AUDIT_LOG,
        exportScope: 'reference',
      },
      {
        path: 'target.id',
        matchBy: 'userId',
        action: 'retain',
        ...AUDIT_LOG,
        where: { 'target.kind': 'user' },
      },
    ],
    secretPaths: ['related.impersonationSessionId'],
    // Written by `approvalAuditDetails` (server/admin/approvals/auditWriter.ts) and the team grant in
    // server/admin/creditGrants/grantSubscription.ts: the requesting admin and the org owner.
    withheldPaths: ['details.approval.requestedBy', 'details.organizationOwnerId'],
    unmatchedPaths: { 'actor.email': 'The acting admin, kept in the audit trail; not resolved to their account.' },
  },
  // A reviewer's sign-off on an audit entry: the sign-off stays, the link to the reviewer goes.
  AdminAuditReview: {
    kind: 'holder',
    references: [{ path: 'reviewer.userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['reviewer.name'] }],
  },
  // Expires on its own (TTL index) once the admin's gated action has written its audit rows.
  AdminGateReservation: {
    kind: 'holder',
    references: [{ path: 'actorUserId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  AdminSavedView: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
    unrelatedPaths: ['shared'],
  },
  AdminSettings: {
    kind: 'noUserData',
    // Not erased per person: a staff address in a notification setting is operator configuration.
    note: 'Platform configuration. Some settings hold staff email addresses (alert recipients), which the operator maintains.',
  },
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
  // Kept so a re-run cannot act twice on one detection revision, like the detection it acts on.
  AutoContainmentDecision: {
    kind: 'holder',
    references: [
      {
        path: 'userIds',
        matchBy: 'userId',
        action: 'retain',
        reason: 'Fraud containment record kept to prevent repeat abuse (GDPR Art. 17(3)(e) / Art. 6(1)(f))',
        retention: expiresAfterTtl('decidedAt', 365),
      },
    ],
  },
  BusinessMetricState: {
    kind: 'noUserData',
    note: 'Platform metric sampling state; `subscribers` is a count.',
    unrelatedPaths: ['subscribers'],
  },
  // Keys embed user ids (`rate-limit:<userId>:<route>`) but a key is one opaque string with no field to match on, and
  // every row expires on its TTL.
  Cache: {
    kind: 'noUserData',
    note: 'Short-lived dedupe, lease and rate-limit entries keyed by an opaque string; rows expire on their TTL.',
  },
  // An admin's working list of accounts suspected of acting together; the evidence lives on the linked detection
  // (`sourceDetectionId`), so an erased member is pulled and the owner anonymized.
  CampaignWatch: {
    kind: 'holder',
    references: [
      { path: 'userIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'ownerId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  // Activity counters behind platform metrics: the row stays for the aggregates, the person's identity goes.
  CounterLog: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['userName'] },
      // Free-form context on admin and membership counters.
      { path: 'metadata.userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'metadata.targetUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'metadata.memberEmail', matchBy: 'email', action: 'anonymize' },
      { path: 'metadata.email', matchBy: 'email', action: 'anonymize' },
    ],
  },
  Counters: { kind: 'noUserData', note: 'Platform-wide named counters.' },
  DlqFailure: {
    kind: 'noUserData',
    note: 'Queue failure metadata keyed by SQS message ID, not a user reference. Thrown error text may contain incidental identifiers and expires after 15 days.',
  },
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
    // `subscriberIds` are newsletter subscriber records, not user ids; the flags select whole audiences.
    unrelatedPaths: [
      'totalEmailsSent',
      'recipientFilter.allUsers',
      'recipientFilter.allSubscribers',
      'recipientFilter.subscriberIds',
    ],
  },
  EmailPreferences: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      {
        path: 'email',
        matchBy: 'email',
        action: 'retain',
        ...EMAIL_SUPPRESSION,
      },
    ],
    secretPaths: ['unsubscribeToken'],
    // A newsletter subscriber record, not a user id.
    unrelatedPaths: ['subscriberId'],
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
    unrelatedPaths: ['platformEmailAddress', 'rawEmailS3Key', 'sharedWithTeams'],
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
    secretPaths: ['ingestClaimToken'],
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
  // `userId` is the owner. Deleting a team organization would remove its members' workspace, so the owner link is
  // anonymized here. Deleting the person's personal organizations (the `personal` flag, which
  // `purgeAccountContent` filters on) is deferred to the erasure flow.
  // `userDetails.email` and `.name` are removed with the element that `userDetails.id` pulls.
  // `serviceAccountUserId` names the org's system service account, never a person.
  Organization: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['billingContact'] },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'adminUserIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'userDetails.id', matchBy: 'userId', action: 'pullFromArray' },
    ],
    unrelatedPaths: [
      'userDetails.email',
      'maxCreditsPerMember',
      'signupGrantUnlockCount',
      'signupInviteBonusCount',
      'serviceAccountUserId',
    ],
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
  // A fraud-detection record naming several accounts and a network. The person is pulled from
  // `userIds` (`shadowDetectionRepository.removeUser`), which also deletes a record left naming no one
  // and rebuilds or deletes a campaign group; reviewer verdicts are anonymized.
  ShadowDetection: {
    kind: 'holder',
    references: [
      { path: 'userIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'verdicts.reviewerId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  SlackAuditLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['slackUserId', 'ipAddress'] }],
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
    unrelatedPaths: ['includeUserNames'],
  },
  SreErrorPattern: { kind: 'noUserData', note: 'Learned error diagnosis pattern.' },
  // `fixVerdict.by` is a GitHub login of a staff reviewer, not a Bike4Mind user reference.
  SreErrorTracking: {
    kind: 'holder',
    references: [
      { path: 'affectedUserIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'dismissedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
    unmatchedPaths: { 'fixVerdict.by': 'GitHub login of the reviewer; no link to a user id is stored.' },
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
  TaskSchedule: {
    kind: 'holder',
    // A job queued for the person (a reminder, a digest) would otherwise run after the erasure.
    references: [{ path: 'payload.userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
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
