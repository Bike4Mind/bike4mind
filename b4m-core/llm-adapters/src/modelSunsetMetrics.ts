import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Logger } from '@bike4mind/observability';

/**
 * Telemetry for the silent half of model deprecation.
 *
 * A model that 404s upstream reports itself. A stored pin on a model that is
 * deprecated but still resolves is silent: the resolver upgrades it, the user
 * gets a plausible answer either way, and nobody files a ticket. `[model-sunset]`
 * log lines record it but are not alarmable, so this publishes the same event as
 * a metric.
 *
 * Emitted from resolveDeprecatedModelId, which is the last point that still sees
 * the id the caller ASKED for. Downstream is useless for this: getAvailableModels
 * drops every model at or past its deprecationDate, so any ModelInfo reaching
 * getLlmByModel has isModelDeprecated() === false by construction.
 *
 * Blind spot: a deprecated id with no successor resolves to itself and emits
 * nothing. The deprecationDate <-> mapping invariant enforced in
 * resolveDeprecatedModel.test.ts is what keeps that set empty.
 *
 * Keep the names below in sync with infra/alarms.ts (`deprecatedModelRequest`)
 * and infra/modelSunsetDashboard.ts; the tests pin the literals.
 */
export const MODEL_SUNSET_NAMESPACE = 'Lumina5/ModelSunset';
export const DEPRECATED_MODEL_REQUEST_METRIC = 'DeprecatedModelRequest';

/**
 * Emits the deprecated-model-request metric. Fire-and-forget: never throws, and
 * never blocks the request it is reporting on.
 *
 * No-ops outside deployed stages (`SEED_STAGE_NAME` comes from
 * DEFAULT_LAMBDA_ENVIRONMENT in infra/constants.ts) - a CLI, self-host, or test
 * run has no CloudWatch to publish to, and this sits on the request path.
 */
export async function recordDeprecatedModelRequest(
  requestedModelId: string,
  resolvedModelId: string,
  logger?: Logger
): Promise<void> {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  try {
    // Fresh client per call: warm Lambda containers outlive their credentials,
    // and a module-level client captures expired ones (see server/utils/cloudwatch.ts).
    const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    const timestamp = new Date();

    await client.send(
      new PutMetricDataCommand({
        Namespace: MODEL_SUNSET_NAMESPACE,
        MetricData: [
          // A CloudWatch alarm matches one exact dimension set, so the Stage-only
          // datapoint is the alarmable one; the wider set exists for the
          // requests-by-deprecated-model dashboard panel. They are separate
          // metrics to CloudWatch, so neither double-counts the other.
          {
            MetricName: DEPRECATED_MODEL_REQUEST_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            Dimensions: [{ Name: 'Stage', Value: stage }],
          },
          {
            MetricName: DEPRECATED_MODEL_REQUEST_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            // Model is the id the caller pinned, not what it resolved to - the
            // pin is the thing an operator has to go rewrite.
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Model', Value: requestedModelId },
            ],
          },
        ],
      })
    );
  } catch (error) {
    (logger ?? Logger.globalInstance).warn('[model-sunset] Failed to emit DeprecatedModelRequest metric', {
      requestedModel: requestedModelId,
      resolvedModel: resolvedModelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
