import type { DataHolderRegistry } from '../types';

export const contentHolders = {
  Activity: {
    kind: 'holder',
    // `ownerType` is the Mongoose model name the feed entry was created for (see ActivityRepository).
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', where: { ownerType: 'User' } }],
    // `ownerName` goes with the document when the person owns it, and names the owning entity otherwise.
    unrelatedPaths: ['ownerName'],
    unmatchedPaths: { receiverName: 'Cached display name of the receiver; the receiver id is not stored.' },
  },
  // Authored annotation threads go with their author; resolving or deleting someone else's is attribution only.
  Annotation: {
    kind: 'holder',
    references: [
      { path: 'authorId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'deletedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'resolvedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  AppFile: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Artifact: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'permissions.canRead', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'permissions.canWrite', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'permissions.canDelete', matchBy: 'userId', action: 'pullFromArray' },
    ],
  },
  ArtifactContent: { kind: 'viaParent', parent: 'Artifact', foreignKey: 'artifactId' },
  // Versions follow the artifact so no content outlives it; a collaborator's version of someone
  // else's artifact survives with its author anonymized.
  ArtifactVersion: {
    kind: 'viaParent',
    parent: 'Artifact',
    foreignKey: 'artifactId',
    attribution: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  BriefcasePrompt: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  DailyReport: { kind: 'noUserData', note: 'Platform-wide generated activity summary for a date, not per person.' },
  DungeonInstance: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  FabFile: {
    kind: 'holder',
    references: [
      // A personal upload goes; a file uploaded into an organization's lake is the org's and stays,
      // with the uploader cleared (the anonymize below; precedence is in types.ts).
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument', where: { organizationId: null } },
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'supersededInLakes.decidedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: ['presignedUrl', 'fileUrl'],
  },
  FabFileChunk: { kind: 'viaParent', parent: 'FabFile', foreignKey: 'fabFileId' },
  Favorite: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  GearOverride: {
    kind: 'holder',
    references: [{ path: 'updatedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  GearStamp: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  ImageGenerationTemplate: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // A safety incident, possibly reported to a child-protection authority: kept against the uploader.
  ImageModerationIncident: {
    kind: 'holder',
    references: [
      {
        path: 'userId',
        matchBy: 'userId',
        action: 'retain',
        reason:
          'Safety incident kept for legal reporting obligations and to prevent repeat abuse (GDPR Art. 17(3)(b), (e))',
      },
      { path: 'falsePositiveBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'noActionBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'reportedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  ImportHistoryJob: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Memento: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Project: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
    ],
  },
  Prompt: { kind: 'noUserData', note: 'Shared prompt catalogue with no owner field.' },
  PublishedArtifact: {
    kind: 'holder',
    references: [
      // Only personal pages go. Account deletion hands an organization page a colleague published to that
      // colleague (`purgeOwnerPublishedArtifacts`), and removes thumbnails and CDN copies
      // (`purgeUserPublishedArtifacts`), so erasure must call those rather than delete the rows.
      { path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', where: { tier: 'user' } },
      { path: 'deletedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'lastPublishedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'previousVersionMeta.publishedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'versions.publishedBy', matchBy: 'userId', action: 'anonymize' },
    ],
    secretPaths: ['shareTokens.token', 'accessGate.passphraseHash'],
  },
  // Moderation record about someone else's artifact: the report stays, the reporter's identity goes.
  PublishedArtifactReport: {
    kind: 'holder',
    references: [
      { path: 'reporterId', matchBy: 'userId', action: 'anonymize' },
      { path: 'resolvedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  // The owner's view log: it goes with an erased personal page (as `purgeOwnerPublishedArtifacts` does),
  // otherwise the row stays for the artifact owner and the viewer's identity goes.
  PublishedArtifactViewAudit: {
    kind: 'viaParent',
    parent: 'PublishedArtifact',
    foreignKey: 'publicId',
    parentKey: 'publicId',
    attribution: [
      {
        path: 'viewerId',
        matchBy: 'userId',
        action: 'anonymize',
        alsoRedact: ['sourceIp', 'userAgent', 'viewerEmailDomain'],
      },
    ],
  },
  QuestExternalLink: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'createdBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  QuestGraph: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  QuestMasterPlan: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'sharedWith', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'handoff.lastUpdatedBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'decisions.madeBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  QuestNode: { kind: 'viaParent', parent: 'QuestGraph', foreignKey: 'graphId' },
  ReleaseNote: { kind: 'noUserData', note: 'Platform release notes, not per person.' },
  ResearchData: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  ResearchLink: { kind: 'noUserData', note: 'Shared research link catalogue with no owner field.' },
  ResearchLinkCategory: { kind: 'noUserData', note: 'Shared research link categories with no owner field.' },
  StockPortfolio: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // Simulated agent trades, not real money, so no accounting retention applies.
  StockTrade: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  SystemPrompt: {
    kind: 'holder',
    references: [
      { path: 'createdBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'lastUpdatedBy', matchBy: 'userId', action: 'anonymize', alsoRedact: ['lastUpdatedByName'] },
    ],
  },
  SystemPromptHistory: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize', alsoRedact: ['createdByName'] }],
  },
  Tag: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  TavernMap: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  TavernQuest: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  TavernWorld: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  WeeklyReport: { kind: 'noUserData', note: 'Platform-wide generated activity summary for a week, not per person.' },
  // The `file` discriminator of Tag (TagType.FILE), stored in the same `tags` collection.
  file: { kind: 'discriminator', base: 'Tag' },
} satisfies DataHolderRegistry;
