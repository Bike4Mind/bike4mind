import {
  agentExecutionRepository,
  CodeAgentEvent,
  CreditLot,
  CreditTransaction,
  ToolExecutionLog,
  UsageEvent,
  UserApiKeyAuditLog,
  UserAuthAuditLogModel,
} from '@bike4mind/database';
import { accountArchiveHistoryService } from '@bike4mind/services';

const projection = (owner: string, names: readonly string[]) =>
  Object.fromEntries([['_id', 0], [owner, 1], ...names.map(name => [name, 1])]);

export async function collectAccountHistoryFromDatabase(userId: string) {
  const { collectAccountHistory } = accountArchiveHistoryService;
  return collectAccountHistory(userId, {
    toolExecutions: async id =>
      ToolExecutionLog.find({ userId: id })
        .select(projection('userId', ['toolName', 'timestamp', 'success', 'executionTimeMs']))
        .sort({ timestamp: -1 })
        .lean(),
    agentExecutions: async id => {
      const rows = await agentExecutionRepository.find(
        { userId: id },
        {
          ...projection('userId', ['status', 'model', 'totalCreditsUsed', 'startedAt', 'completedAt', 'createdAt']),
          sort: { createdAt: -1 },
        }
      );
      return rows.map(row => Object.fromEntries(Object.entries(row)));
    },
    codeAgentEvents: async id =>
      CodeAgentEvent.find({ userId: id })
        .select(projection('userId', ['type', 'status', 'role', 'occurredAt', 'isError', 'allow', 'resolvedBy']))
        .sort({ occurredAt: -1 })
        .lean(),
    creditTransactions: async id =>
      CreditTransaction.find({ ownerId: id, ownerType: 'User' })
        .select(
          projection('ownerId', [
            'ownerType',
            'type',
            'credits',
            'amount',
            'status',
            'model',
            'inputTokens',
            'outputTokens',
            'source',
            'createdAt',
          ])
        )
        .sort({ createdAt: -1 })
        .lean(),
    creditLots: async id =>
      CreditLot.find({ ownerId: id, ownerType: 'User' })
        .select(
          projection('ownerId', [
            'ownerType',
            'source',
            'amount',
            'consumedAssigned',
            'expiresAt',
            'settledAt',
            'createdAt',
          ])
        )
        .sort({ createdAt: -1 })
        .lean(),
    usageEvents: async id =>
      UsageEvent.find({ ownerId: id, ownerType: 'User', userId: id })
        .select(
          projection('ownerId', [
            'ownerType',
            'userId',
            'feature',
            'provider',
            'model',
            'inputTokens',
            'outputTokens',
            'costUsd',
            'creditsCharged',
            'status',
            'createdAt',
          ])
        )
        .sort({ createdAt: -1 })
        .lean(),
    authAudit: async id =>
      UserAuthAuditLogModel.find({ userId: id })
        .select(projection('userId', ['event', 'strategy', 'createdAt']))
        .sort({ createdAt: -1 })
        .lean(),
    apiKeyAudit: async id =>
      UserApiKeyAuditLog.find({ actorUserId: id })
        .select(projection('actorUserId', ['action', 'createdAt']))
        .sort({ createdAt: -1 })
        .lean(),
  });
}
