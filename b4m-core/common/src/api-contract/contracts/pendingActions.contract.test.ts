import { describe, expect, it } from 'vitest';
import { approvePendingActionContract, denyPendingActionContract } from './pendingActions.contract';
import { PendingActionDecisionRequestSchema } from '../../schemas/pendingActions';

describe('pending action contracts', () => {
  it('pins operation ids, paths and verbs, and accepts a JWT only', () => {
    expect(
      [approvePendingActionContract, denyPendingActionContract].map(c => [c.operationId, c.method, c.path, c.auth])
    ).toEqual([
      ['approvePendingAction', 'post', '/api/v1/pending-actions/{questId}/approve', 'jwtOnly'],
      ['denyPendingAction', 'post', '/api/v1/pending-actions/{questId}/deny', 'jwtOnly'],
    ]);
  });

  it('requires pendingActionTs to be a positive integer', () => {
    expect(PendingActionDecisionRequestSchema.safeParse({ pendingActionTs: 1767225600000 }).success).toBe(true);
    for (const bad of [0, -1, 1.5, '123', undefined]) {
      expect(PendingActionDecisionRequestSchema.safeParse({ pendingActionTs: bad }).success).toBe(false);
    }
    expect(PendingActionDecisionRequestSchema.safeParse({}).success).toBe(false);
  });
});
