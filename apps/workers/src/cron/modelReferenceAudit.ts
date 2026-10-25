import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Logger } from '@bike4mind/observability';
import { modelDiscoveryStateRepository } from '@bike4mind/database';
import type { StaleModelReference } from '@bike4mind/llm-adapters';
import { modelReferenceReport } from '@bike4mind/server-utils/modelDiscovery/modelReferenceReport';

const logger = new Logger({ metadata: { service: 'modelReferenceAudit' } });

export function actionableModelReferences(references: readonly StaleModelReference[]): StaleModelReference[] {
  return references.filter(reference => {
    if (reference.surface === 'fallback-chain-key') return false;
    // Optional fallback providers can deliberately be unconfigured on this deployment.
    if (reference.problem !== 'not-invocable') return true;
    return reference.surface === 'configured-model' || reference.surface === 'agent-model';
  });
}

export async function auditModelReferences(stage: string): Promise<void> {
  try {
    const [report, pendingSuggestions] = await Promise.all([
      modelReferenceReport(),
      modelDiscoveryStateRepository.pendingSuggestions(),
    ]);
    const references = actionableModelReferences(report);
    for (const reference of references) {
      logger.warn('[model-reference-audit] unavailable model reference', { ...reference });
    }
    const cloudWatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    await cloudWatch.send(
      new PutMetricDataCommand({
        Namespace: 'Lumina5/ModelDiscovery',
        MetricData: [
          {
            MetricName: 'LifecycleSuggestions',
            Value: pendingSuggestions.length,
            Unit: StandardUnit.Count,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Host', Value: 'hosted' },
            ],
          },
          {
            MetricName: 'UnavailableModelReferences',
            Value: references.length,
            Unit: StandardUnit.Count,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Host', Value: 'hosted' },
            ],
          },
        ],
      })
    );
  } catch (error) {
    logger.error('[model-reference-audit] check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
