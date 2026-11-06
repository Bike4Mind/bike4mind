import type { ReconcileResult } from './reconcilePurchaseStamps';

export function summaryMessage(stage: string, result: Pick<ReconcileResult, 'cleared' | 'reversals'>): string {
  return `Paid standing reconcile (${stage}): cleared ${result.cleared} stamp(s), reversed ${result.reversals.length} purchase(s)`;
}
