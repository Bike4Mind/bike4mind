type Row = Record<string, unknown>;

export type AccountHistoryReaders = {
  toolExecutions: (userId: string) => Promise<Row[]>;
  agentExecutions: (userId: string) => Promise<Row[]>;
  codeAgentEvents: (userId: string) => Promise<Row[]>;
  creditTransactions: (userId: string) => Promise<Row[]>;
  creditLots: (userId: string) => Promise<Row[]>;
  usageEvents: (userId: string) => Promise<Row[]>;
  authAudit: (userId: string) => Promise<Row[]>;
  apiKeyAudit: (userId: string) => Promise<Row[]>;
};

const fields = <T extends Row>(row: Row, names: readonly string[]): T => {
  const safe: Row = {};
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[name] = value;
    } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
      safe[name] = value.toISOString();
    }
  }
  return safe as T;
};

const toolFields = ['toolName', 'timestamp', 'success', 'executionTimeMs'] as const;
const agentFields = ['status', 'model', 'totalCreditsUsed', 'startedAt', 'completedAt', 'createdAt'] as const;
const eventFields = ['type', 'status', 'role', 'occurredAt', 'isError', 'allow', 'resolvedBy'] as const;
const transactionFields = [
  'type',
  'credits',
  'amount',
  'status',
  'model',
  'inputTokens',
  'outputTokens',
  'source',
  'createdAt',
] as const;
const lotFields = ['source', 'amount', 'consumedAssigned', 'expiresAt', 'settledAt', 'createdAt'] as const;
const usageFields = [
  'feature',
  'provider',
  'model',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'creditsCharged',
  'status',
  'createdAt',
] as const;
const authFields = ['event', 'strategy', 'createdAt'] as const;
const keyAuditFields = ['action', 'createdAt'] as const;

/**
 * Call only after authorizing the archive requester for this account.
 * The API-key audit covers actions the user took (`actorUserId`), not actions others took on the user's keys.
 */
export async function collectAccountHistory(userId: string, readers: AccountHistoryReaders) {
  if (!userId) throw new Error('Account id is required');
  const [tools, agents, events, transactions, lots, usage, auth, keys] = await Promise.all([
    readers.toolExecutions(userId),
    readers.agentExecutions(userId),
    readers.codeAgentEvents(userId),
    readers.creditTransactions(userId),
    readers.creditLots(userId),
    readers.usageEvents(userId),
    readers.authAudit(userId),
    readers.apiKeyAudit(userId),
  ]);

  // Readers must return owner ids as strings: strict equality drops ObjectId-typed ids.
  const owned = (rows: Row[], field: string) => rows.filter(row => row[field] === userId);
  const billedToUser = (rows: Row[]) => rows.filter(row => row.ownerId === userId && row.ownerType === 'User');
  return {
    toolExecutions: owned(tools, 'userId').map(row => fields(row, toolFields)),
    agentExecutions: owned(agents, 'userId').map(row => fields(row, agentFields)),
    codeAgentEvents: owned(events, 'userId').map(row => fields(row, eventFields)),
    creditTransactions: billedToUser(transactions).map(row => fields(row, transactionFields)),
    creditLots: billedToUser(lots).map(row => fields(row, lotFields)),
    usageEvents: billedToUser(usage)
      .filter(row => row.userId === userId)
      .map(row => fields(row, usageFields)),
    authAudit: owned(auth, 'userId').map(row => fields(row, authFields)),
    apiKeyAudit: owned(keys, 'actorUserId').map(row => fields(row, keyAuditFields)),
  };
}
