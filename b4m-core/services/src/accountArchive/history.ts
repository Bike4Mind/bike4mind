type Row = Record<string, unknown>;

export type AccountHistoryReaders = {
  toolExecutions: (userId: string) => Promise<object[]>;
  agentExecutions: (userId: string) => Promise<object[]>;
  codeAgentEvents: (userId: string) => Promise<object[]>;
  creditTransactions: (userId: string) => Promise<object[]>;
  creditLots: (userId: string) => Promise<object[]>;
  usageEvents: (userId: string) => Promise<object[]>;
  authAudit: (userId: string) => Promise<object[]>;
  apiKeyAudit: (userId: string) => Promise<object[]>;
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

/** Call only after authorizing the archive requester for this account. */
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

  const owned = (rows: object[], field: string) => rows.filter(row => (row as Row)[field] === userId) as Row[];
  const billedToUser = (rows: object[]) =>
    rows.filter(row => (row as Row).ownerId === userId && (row as Row).ownerType === 'User') as Row[];
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
