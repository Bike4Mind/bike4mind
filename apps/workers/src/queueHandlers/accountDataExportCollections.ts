import { Readable } from 'node:stream';
import { mongoose } from '@bike4mind/database';

export interface AccountArchiveCollection {
  name: string;
  path?: string;
  count: number;
  representation: 'metadata';
  omitted?: 'time_limit';
}

export interface AccountArchiveAdapter {
  name: string;
  collect: (
    userId: string,
    personalOrganizationIds: readonly string[]
  ) => Promise<{ records: Readable; count: () => number }>;
}

// Every direct, owner-filtered purge model needs an explicit archive policy. Until a dedicated
// collector exists, only stable record identifiers and timestamps leave the database.
export const ACCOUNT_ARCHIVE_METADATA_MODELS = [
  'ToolModel',
  'Memento',
  'ResearchAgent',
  'ResearchTask',
  'WorkItem',
  'AgentExecution',
  'Favorite',
  'Tag',
  'BriefcasePrompt',
  'ImageGenerationTemplate',
  'ResearchData',
  'StockPortfolio',
  'StockTrade',
  'TavernQuest',
  'QuestMasterPlan',
  'QuestExternalLink',
  'GearStamp',
  'AuthSession',
  'TrustedDevice',
  'PasskeyCredential',
  'OAuthGrant',
  'OAuthRefreshToken',
  'OAuthAuthorizationCode',
  'UserApiKey',
  'ApiKey',
  'PushToken',
  'DeviceAuthorization',
  'CcBridgeDevice',
  'CcBridgePairingToken',
  'WsConnectTicket',
  'PasskeyChallenge',
  'UserActivityCounter',
  'UserUsagePatternSignals',
  'AdminUserNote',
  'AdminUserNoteRevision',
  'FeedbackNote',
  'ActiveCodeAgent',
  'CodeAgentEvent',
  'SessionAgentConfig',
  'SessionToolApproval',
] as const;

const ownerIds = (userId: string) => {
  const objectId = new mongoose.Types.ObjectId(userId);
  return { userId: { $in: [userId, objectId.toHexString(), objectId] } };
};
const ownerOnly = new Set<string>([
  'AuthSession',
  'TrustedDevice',
  'PasskeyCredential',
  'OAuthGrant',
  'OAuthRefreshToken',
  'OAuthAuthorizationCode',
  'UserApiKey',
  'ApiKey',
  'PushToken',
  'DeviceAuthorization',
  'CcBridgeDevice',
  'CcBridgePairingToken',
  'WsConnectTicket',
  'PasskeyChallenge',
  'UserActivityCounter',
  'UserUsagePatternSignals',
  'AdminUserNote',
  'AdminUserNoteRevision',
  'FeedbackNote',
  'ActiveCodeAgent',
  'CodeAgentEvent',
  'SessionAgentConfig',
  'SessionToolApproval',
]);

export function accountArchiveFilter(name: string, userId: string, personalOrganizationIds: readonly string[]) {
  if (ownerOnly.has(name)) return ownerIds(userId);
  return {
    $or: [
      { ...ownerIds(userId), organizationId: { $in: [null, ''] } },
      { organizationId: { $in: personalOrganizationIds } },
    ],
  };
}

export function accountArchiveMetadata(row: { _id: unknown; createdAt?: unknown; updatedAt?: unknown }) {
  return { id: String(row._id), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export const accountArchiveAdapters: readonly AccountArchiveAdapter[] = ACCOUNT_ARCHIVE_METADATA_MODELS.map(name => ({
  name,
  async collect(userId, personalOrganizationIds) {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Account archive requires a connected database');
    const collection = db.collection(mongoose.model(name).collection.name);
    const cursor = collection.find(accountArchiveFilter(name, userId, personalOrganizationIds), {
      projection: { _id: 1, createdAt: 1, updatedAt: 1 },
    });
    let count = 0;
    const records = Readable.from(
      (async function* () {
        try {
          for await (const row of cursor) {
            count++;
            yield JSON.stringify(accountArchiveMetadata(row)) + '\n';
          }
        } finally {
          await cursor.close();
        }
      })()
    );
    return { records, count: () => count };
  },
}));
