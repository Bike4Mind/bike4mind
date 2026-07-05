import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';

/**
 * CloudWatch metric dimensions
 */
export interface MetricDimensions {
  [key: string]: string;
}

/**
 * Emit a metric to CloudWatch
 *
 * @param namespace - CloudWatch namespace (e.g., 'Lumina5/ModalGeneration')
 * @param metricName - Name of the metric
 * @param value - Numeric value
 * @param dimensions - Optional dimensions for filtering/grouping
 * @param unit - CloudWatch unit (default: None)
 */
export async function emitMetric(
  namespace: string,
  metricName: string,
  value: number,
  dimensions: MetricDimensions = {},
  unit: StandardUnit = StandardUnit.None
): Promise<void> {
  try {
    // Create client on each call to ensure fresh AWS credentials.
    // Lambda containers can stay warm for extended periods (>15-60 min), causing
    // module-level clients to capture expired credentials. This pattern prevents
    // production failures: "InvalidSignatureException: Signature expired"
    const client = new CloudWatchClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    const command = new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: unit,
          Timestamp: new Date(),
          Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({
            Name,
            Value,
          })),
        },
      ],
    });

    await client.send(command);
  } catch (error) {
    // Log but don't throw - metrics failures shouldn't break the application
    console.error('Failed to emit CloudWatch metric', {
      namespace,
      metricName,
      value,
      dimensions,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Emit multiple metrics in a single API call for efficiency
 */
export async function emitMetrics(
  namespace: string,
  metrics: Array<{
    name: string;
    value: number;
    dimensions?: MetricDimensions;
    unit?: StandardUnit;
  }>
): Promise<void> {
  if (metrics.length === 0) return;

  try {
    // Create client on each call to ensure fresh AWS credentials.
    // Lambda containers can stay warm for extended periods (>15-60 min), causing
    // module-level clients to capture expired credentials. This pattern prevents
    // production failures: "InvalidSignatureException: Signature expired"
    const client = new CloudWatchClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    const command = new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: metrics.map(metric => ({
        MetricName: metric.name,
        Value: metric.value,
        Unit: metric.unit || StandardUnit.None,
        Timestamp: new Date(),
        Dimensions: metric.dimensions
          ? Object.entries(metric.dimensions).map(([Name, Value]) => ({
              Name,
              Value,
            }))
          : [],
      })),
    });

    await client.send(command);
  } catch (error) {
    console.error('Failed to emit CloudWatch metrics', {
      namespace,
      metricsCount: metrics.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Modal Generation specific metric emitter
 */
export async function emitModalGenerationMetric(
  metricName: string,
  value: number,
  dimensions: MetricDimensions = {},
  unit: StandardUnit = StandardUnit.None
): Promise<void> {
  return emitMetric('Lumina5/ModalGeneration', metricName, value, dimensions, unit);
}

/**
 * Emit multiple modal generation metrics
 */
export async function emitModalGenerationMetrics(
  metrics: Array<{
    name: string;
    value: number;
    dimensions?: MetricDimensions;
    unit?: StandardUnit;
  }>
): Promise<void> {
  return emitMetrics('Lumina5/ModalGeneration', metrics);
}

// Webhook Delivery Metrics - Namespace: Lumina5/WebhookDelivery
// DeliveryAttempted, DeliverySucceeded, DeliveryFailed, DeliverySkipped,
// DeliveryLatency, HttpResponseCode, RetryCount, SubscriberCount

const WEBHOOK_DELIVERY_NAMESPACE = 'Lumina5/WebhookDelivery';

/**
 * Webhook delivery specific metric emitter
 */
export async function emitWebhookDeliveryMetric(
  metricName: string,
  value: number,
  dimensions: MetricDimensions = {},
  unit: StandardUnit = StandardUnit.None
): Promise<void> {
  return emitMetric(WEBHOOK_DELIVERY_NAMESPACE, metricName, value, dimensions, unit);
}

/**
 * Emit multiple webhook delivery metrics
 */
export async function emitWebhookDeliveryMetrics(
  metrics: Array<{
    name: string;
    value: number;
    dimensions?: MetricDimensions;
    unit?: StandardUnit;
  }>
): Promise<void> {
  return emitMetrics(WEBHOOK_DELIVERY_NAMESPACE, metrics);
}

/**
 * Webhook delivery metric names (typed constants)
 */
export const WebhookMetrics = {
  DELIVERY_ATTEMPTED: 'DeliveryAttempted',
  DELIVERY_SUCCEEDED: 'DeliverySucceeded',
  DELIVERY_FAILED: 'DeliveryFailed',
  DELIVERY_SKIPPED: 'DeliverySkipped',
  DELIVERY_LATENCY: 'DeliveryLatency',
  HTTP_RESPONSE_CODE: 'HttpResponseCode',
  RETRY_COUNT: 'RetryCount',
  SUBSCRIBER_COUNT: 'SubscriberCount',
} as const;

/**
 * Record a successful webhook delivery with all relevant metrics
 */
export async function recordWebhookDeliverySuccess(
  orgId: string,
  eventType: string,
  latencyMs: number,
  httpStatusCode: number,
  retryCount: number
): Promise<void> {
  const baseDimensions = { orgId, eventType };

  return emitWebhookDeliveryMetrics([
    { name: WebhookMetrics.DELIVERY_ATTEMPTED, value: 1, dimensions: baseDimensions, unit: StandardUnit.Count },
    { name: WebhookMetrics.DELIVERY_SUCCEEDED, value: 1, dimensions: baseDimensions, unit: StandardUnit.Count },
    { name: WebhookMetrics.DELIVERY_LATENCY, value: latencyMs, dimensions: { orgId }, unit: StandardUnit.Milliseconds },
    {
      name: WebhookMetrics.HTTP_RESPONSE_CODE,
      value: 1,
      dimensions: { statusCode: String(httpStatusCode) },
      unit: StandardUnit.Count,
    },
    { name: WebhookMetrics.RETRY_COUNT, value: retryCount, dimensions: { orgId }, unit: StandardUnit.Count },
  ]);
}

/**
 * Record a failed webhook delivery with error details
 */
export async function recordWebhookDeliveryFailure(
  orgId: string,
  eventType: string,
  latencyMs: number,
  httpStatusCode: number,
  errorType: string
): Promise<void> {
  const baseDimensions = { orgId, eventType };

  return emitWebhookDeliveryMetrics([
    { name: WebhookMetrics.DELIVERY_ATTEMPTED, value: 1, dimensions: baseDimensions, unit: StandardUnit.Count },
    {
      name: WebhookMetrics.DELIVERY_FAILED,
      value: 1,
      dimensions: { ...baseDimensions, errorType },
      unit: StandardUnit.Count,
    },
    { name: WebhookMetrics.DELIVERY_LATENCY, value: latencyMs, dimensions: { orgId }, unit: StandardUnit.Milliseconds },
    ...(httpStatusCode > 0
      ? [
          {
            name: WebhookMetrics.HTTP_RESPONSE_CODE,
            value: 1,
            dimensions: { statusCode: String(httpStatusCode) },
            unit: StandardUnit.Count,
          },
        ]
      : []),
  ]);
}

/**
 * Record a skipped webhook delivery
 */
export async function recordWebhookDeliverySkipped(orgId: string, eventType: string, reason: string): Promise<void> {
  return emitWebhookDeliveryMetric(
    WebhookMetrics.DELIVERY_SKIPPED,
    1,
    { orgId, eventType, reason },
    StandardUnit.Count
  );
}

/**
 * Record subscriber count for a fan-out event
 */
export async function recordWebhookSubscriberCount(orgId: string, subscriberCount: number): Promise<void> {
  return emitWebhookDeliveryMetric(WebhookMetrics.SUBSCRIBER_COUNT, subscriberCount, { orgId }, StandardUnit.Count);
}

// Rate Limit Metrics - Namespace: Lumina5/RateLimits
// UsagePercent (0-100), Throttled (429 count), NearLimit (usage > 80%)

const RATE_LIMIT_NAMESPACE = 'Lumina5/RateLimits';

/**
 * Rate limit metric names (typed constants)
 */
export const RateLimitMetrics = {
  USAGE_PERCENT: 'UsagePercent',
  THROTTLED: 'Throttled',
  NEAR_LIMIT: 'NearLimit',
} as const;

/**
 * Rate limit specific metric emitter
 */
export async function emitRateLimitMetric(
  metricName: string,
  value: number,
  dimensions: MetricDimensions = {},
  unit: StandardUnit = StandardUnit.None
): Promise<void> {
  return emitMetric(RATE_LIMIT_NAMESPACE, metricName, value, dimensions, unit);
}

/**
 * Record a rate limit event (throttled or near-limit)
 */
export async function recordRateLimitEvent(
  integration: string,
  usagePercent: number | null,
  wasThrottled: boolean,
  endpoint?: string
): Promise<void> {
  const metrics: Array<{
    name: string;
    value: number;
    dimensions?: MetricDimensions;
    unit?: StandardUnit;
  }> = [];

  // Include normalized endpoint dimension when available for per-endpoint observability.
  // Cardinality: ~4 integrations x ~15 endpoint patterns ≈ 60 unique dimension sets.
  const dimensions: MetricDimensions = endpoint ? { integration, endpoint } : { integration };

  if (usagePercent !== null) {
    metrics.push({
      name: RateLimitMetrics.USAGE_PERCENT,
      value: usagePercent,
      dimensions,
      unit: StandardUnit.Percent,
    });
  }

  if (wasThrottled) {
    metrics.push({
      name: RateLimitMetrics.THROTTLED,
      value: 1,
      dimensions,
      unit: StandardUnit.Count,
    });
  }

  if (usagePercent !== null && usagePercent >= 80) {
    metrics.push({
      name: RateLimitMetrics.NEAR_LIMIT,
      value: 1,
      dimensions,
      unit: StandardUnit.Count,
    });
  }

  if (metrics.length > 0) {
    return emitMetrics(RATE_LIMIT_NAMESPACE, metrics);
  }
}

// Token Rotation Metrics - Namespace: Lumina5/TokenRotation
// RotationInitiated { integration, reason }, RotationFailed { integration, errorType }

const TOKEN_ROTATION_NAMESPACE = 'Lumina5/TokenRotation';

export const TokenRotationMetrics = {
  ROTATION_INITIATED: 'RotationInitiated',
  ROTATION_FAILED: 'RotationFailed',
} as const;

/**
 * Token rotation specific metric emitter
 */
export async function emitTokenRotationMetric(
  metricName: string,
  value: number,
  dimensions: MetricDimensions = {},
  unit: StandardUnit = StandardUnit.None
): Promise<void> {
  return emitMetric(TOKEN_ROTATION_NAMESPACE, metricName, value, dimensions, unit);
}

/**
 * Record a successful token rotation initiation
 */
export async function recordTokenRotationInitiated(integration: string, reason: string): Promise<void> {
  return emitTokenRotationMetric(
    TokenRotationMetrics.ROTATION_INITIATED,
    1,
    { integration, reason },
    StandardUnit.Count
  );
}

/**
 * Record a failed token rotation attempt
 */
export async function recordTokenRotationFailed(integration: string, errorType: string): Promise<void> {
  return emitTokenRotationMetric(
    TokenRotationMetrics.ROTATION_FAILED,
    1,
    { integration, errorType },
    StandardUnit.Count
  );
}

// Circuit Breaker Metrics - Namespace: Lumina5/CircuitBreaker
// StateTransition { Integration, FromState, ToState }, CircuitOpen (1/0 per integration), RejectedCalls

const CIRCUIT_BREAKER_NAMESPACE = 'Lumina5/CircuitBreaker';

export const CircuitBreakerMetrics = {
  STATE_TRANSITION: 'StateTransition',
  CIRCUIT_OPEN: 'CircuitOpen',
  REJECTED_CALLS: 'RejectedCalls',
} as const;

/**
 * Record a circuit breaker state transition
 */
export async function recordCircuitBreakerTransition(
  integration: string,
  fromState: string,
  toState: string,
  operationType?: string
): Promise<void> {
  const baseDimensions: MetricDimensions = { Integration: integration };
  if (operationType) baseDimensions.OperationType = operationType;

  return emitMetrics(CIRCUIT_BREAKER_NAMESPACE, [
    {
      name: CircuitBreakerMetrics.STATE_TRANSITION,
      value: 1,
      dimensions: { ...baseDimensions, FromState: fromState, ToState: toState },
      unit: StandardUnit.Count,
    },
    {
      name: CircuitBreakerMetrics.CIRCUIT_OPEN,
      value: toState === 'OPEN' ? 1 : 0,
      dimensions: baseDimensions,
      unit: StandardUnit.None,
    },
  ]);
}

/**
 * Record a call rejected by the circuit breaker
 */
export async function recordCircuitBreakerRejection(integration: string): Promise<void> {
  return emitMetric(
    CIRCUIT_BREAKER_NAMESPACE,
    CircuitBreakerMetrics.REJECTED_CALLS,
    1,
    { Integration: integration },
    StandardUnit.Count
  );
}
