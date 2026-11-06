import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { PENDING_GRANTS_QUERY_KEY } from '@client/app/hooks/data/adminSignupGrant';

// Must stay in sync with userService.MAX_BULK_RELEASE, which both bulk routes cap userIds at.
export const MAX_PENDING_BULK = 100;

export type PendingBulkKind = 'release' | 'block';

type BulkRow = { userId: string; outcome: 'applied' | 'would_apply' | 'noop' | 'failed'; reason?: string };
type BulkResult = { dryRun: boolean; results: BulkRow[]; undoUserIds: string[] };
type ReleaseResult = {
  batchId: string;
  results: { userId: string; outcome: 'released' | 'not_held' | 'withheld' | 'failed'; credits: number }[];
};
type RevokeResult = {
  batchId: string;
  results: { userId: string; outcome: 'reversed' | 'already_reversed' | 'insufficient_balance' | 'failed' }[];
};

/** What the Undo toast reverses. A union so a release batch can never be sent to unblock, or the reverse. */
export type PendingUndo = { kind: 'release'; batchId: string } | { kind: 'block'; userIds: string[] };

export type PendingBulkOutcome = {
  applied: number;
  appliedIds: string[];
  failedIds: string[];
  undo: PendingUndo | null;
};
export type PendingUndoOutcome = { restored: number; insufficientBalance: number; failed: number };

const PATH: Readonly<Record<PendingBulkKind, string>> = {
  release: '/api/admin/held-signup-grants/release',
  block: '/api/admin/signup-grants/bulk-block',
};

export type PendingBulkPreview = { wouldApply: number; noops: { reason: string; count: number }[] };

export const summarizePreview = (result: BulkResult): PendingBulkPreview => {
  const noops = new Map<string, number>();
  let wouldApply = 0;
  for (const row of result.results) {
    if (row.outcome === 'would_apply') wouldApply += 1;
    else {
      const reason = row.reason ?? 'unknown';
      noops.set(reason, (noops.get(reason) ?? 0) + 1);
    }
  }
  return { wouldApply, noops: [...noops].map(([reason, count]) => ({ reason, count })) };
};

/** Turns a real run's response into counts and the undo it supports, or null when it changed nothing. */
export const bulkOutcome = (kind: PendingBulkKind, data: ReleaseResult | BulkResult): PendingBulkOutcome => {
  if (kind === 'release') {
    const { batchId, results } = data as ReleaseResult;
    const appliedIds = results.filter(row => row.outcome === 'released').map(row => row.userId);
    return {
      applied: appliedIds.length,
      appliedIds,
      failedIds: results.filter(row => row.outcome === 'failed').map(row => row.userId),
      undo: appliedIds.length > 0 ? { kind: 'release', batchId } : null,
    };
  }
  const { results, undoUserIds } = data as BulkResult;
  const appliedIds = results.filter(row => row.outcome === 'applied').map(row => row.userId);
  return {
    applied: appliedIds.length,
    appliedIds,
    failedIds: results.filter(row => row.outcome === 'failed').map(row => row.userId),
    undo: undoUserIds.length > 0 ? { kind: 'block', userIds: undoUserIds } : null,
  };
};

const invalidatePending = (queryClient: QueryClient, userIds: readonly string[]) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['held-signup-grants'] }),
    // Same per-account keys as useAdminSignupGrantAction: the ['admin','users',id] prefix covers the pending card,
    // credit summary and credit ledger.
    ...userIds.flatMap(userId => [
      queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
      queryClient.invalidateQueries({ queryKey: ['users', userId] }),
    ]),
  ]);

/** The dry run behind the dialog's count. Never cached: the count must describe the accounts as they are now. */
export const usePendingBulkPreview = (kind: PendingBulkKind, userIds: readonly string[]) =>
  useQuery({
    queryKey: ['admin', 'signup-grant-bulk-preview', kind, userIds],
    queryFn: async (): Promise<PendingBulkPreview> => {
      const response = await api.post<BulkResult>(PATH[kind], { userIds, dryRun: true });
      return summarizePreview(response.data);
    },
    enabled: userIds.length > 0,
    staleTime: 0,
    gcTime: 0,
  });

export const usePendingBulkRun = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      userIds,
      reason,
    }: {
      kind: PendingBulkKind;
      userIds: readonly string[];
      reason: string;
    }): Promise<PendingBulkOutcome> => {
      // The release route takes no reason; its audit entries name the batch instead.
      const body = kind === 'release' ? { userIds } : { userIds, reason };
      const response = await api.post<ReleaseResult | BulkResult>(PATH[kind], body);
      return bulkOutcome(kind, response.data);
    },
    onSettled: (_data, _error, { userIds }) => invalidatePending(queryClient, userIds),
  });
};

export const usePendingBulkUndo = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      undo,
      reason,
    }: {
      undo: PendingUndo;
      reason: string;
      affectedIds: readonly string[];
    }): Promise<PendingUndoOutcome> => {
      if (undo.kind === 'release') {
        const response = await api.post<RevokeResult>('/api/admin/held-signup-grants/revoke', {
          batchId: undo.batchId,
        });
        const count = (outcome: RevokeResult['results'][number]['outcome']) =>
          response.data.results.filter(row => row.outcome === outcome).length;
        return {
          restored: count('reversed'),
          insufficientBalance: count('insufficient_balance'),
          failed: count('failed'),
        };
      }
      const response = await api.post<BulkResult>('/api/admin/signup-grants/bulk-unblock', {
        userIds: undo.userIds,
        reason,
      });
      const count = (outcome: BulkRow['outcome']) =>
        response.data.results.filter(row => row.outcome === outcome).length;
      return { restored: count('applied'), insufficientBalance: 0, failed: count('failed') };
    },
    onSettled: (_data, _error, { affectedIds }) => invalidatePending(queryClient, affectedIds),
  });
};
