import { RUN_BUDGET_EXHAUSTED_ERROR_CODE, type CreditHoldRecord } from '@bike4mind/common';
import { resolveStage } from '../security/resolveStage';

type HoldContext = Pick<CreditHoldRecord, 'ownerId' | 'ownerType'> & {
  featureLabel: string;
  lifecycle: 'request' | 'completion';
};

function emitHoldMetric(
  context: HoldContext,
  metric: 'HoldLatency' | 'SettlementsAfterSweep',
  value: number,
  details: Record<string, unknown> = {}
): void {
  try {
    const Stage = resolveStage();
    const isLatency = metric === 'HoldLatency';
    // Owner ids remain log fields, never high-cardinality CloudWatch dimensions.
    // eslint-disable-next-line no-console -- an EMF line must reach stdout as top-level JSON; Logger would nest it under `message`
    console.info(
      JSON.stringify({
        event: 'creditHoldTelemetry',
        ownerId: context.ownerId,
        ownerType: context.ownerType,
        featureLabel: context.featureLabel,
        lifecycle: context.lifecycle,
        ...details,
        Stage,
        Lifecycle: context.lifecycle,
        ...(isLatency ? { Outcome: details.outcome } : {}),
        [metric]: value,
        ...(process.env.B4M_SELF_HOST === 'true'
          ? {}
          : {
              _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                  {
                    Namespace: 'Lumina5/CreditHolds',
                    Dimensions: [isLatency ? ['Stage', 'Lifecycle', 'Outcome'] : ['Stage', 'Lifecycle']],
                    Metrics: [{ Name: metric, Unit: isLatency ? 'Milliseconds' : 'Count' }],
                  },
                ],
              },
            }),
      })
    );
  } catch {
    // Observability must never change a committed billing outcome.
  }
}

function isRunBudgetRefusal(error: unknown): boolean {
  const info = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo;
  return info?.errorCode === RUN_BUDGET_EXHAUSTED_ERROR_CODE;
}

export async function observeCreditHold<T>(context: HoldContext, reserve: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  let outcome = 'error';
  try {
    const result = await reserve();
    outcome = 'held';
    return result;
  } catch (error) {
    if (isRunBudgetRefusal(error)) outcome = 'refused';
    throw error;
  } finally {
    emitHoldMetric(context, 'HoldLatency', Math.max(0, performance.now() - startedAt), { outcome });
  }
}

export function recordSettlementAfterSweep(context: HoldContext, holdId: string): void {
  emitHoldMetric(context, 'SettlementsAfterSweep', 1, { holdId, outcome: 'missing_hold' });
}
