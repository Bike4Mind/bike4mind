import type { CreditHoldRecord } from '@bike4mind/common';
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

export async function observeCreditHold<T>(context: HoldContext, reserve: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  let outcome = 'error';
  try {
    const result = await reserve();
    outcome = 'held';
    return result;
  } finally {
    emitHoldMetric(context, 'HoldLatency', Math.max(0, performance.now() - startedAt), { outcome });
  }
}

export function recordSettlementAfterSweep(context: HoldContext, holdId: string): void {
  emitHoldMetric(context, 'SettlementsAfterSweep', 1, { holdId, outcome: 'missing_hold' });
}
