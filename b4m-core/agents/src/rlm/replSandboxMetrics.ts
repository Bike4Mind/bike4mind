import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { type ILogger, Logger } from '@bike4mind/observability';

/**
 * Telemetry for the fail-closed branch.
 *
 * Both REPL callers refuse rather than fall back when `isolated-vm` cannot be
 * constructed: the wake drops `code_execute` and continues, `rlm-answer`
 * returns 503. That is the right behaviour and it is also the quiet one - the
 * wake still answers, and a 503 on one route reads as an ordinary transient to
 * everything upstream of it. The signature of the failure this guards against
 * (the native addon absent from a deploy bundle) is that it is total and
 * permanent for that build, so the branch either never fires or fires on every
 * request, and nothing in between. An `error` log records it but is not
 * alarmable; this publishes the same event as a metric so the total case pages.
 *
 * Keep the names below in sync with infra/alarms.ts (`replSandboxUnavailable`);
 * the tests on both sides pin the literals.
 */
export const REPL_SANDBOX_NAMESPACE = 'Lumina5/ReplSandbox';
export const SANDBOX_UNAVAILABLE_METRIC = 'SandboxUnavailable';

/** Which entry point lost its sandbox. Dimension value - keep stable. */
export type ReplSandboxCaller = 'wake' | 'rlm-answer';

/**
 * Emits the sandbox-unavailable metric. Never throws, so a metrics outage
 * cannot turn a degraded run into a failed one.
 *
 * Awaited rather than fire-and-forget: both call sites are a few lines from
 * returning, and a Lambda frozen after its response drops an in-flight
 * PutMetricData - which would lose the datapoint on exactly the run that
 * produced it.
 *
 * No-ops outside deployed stages (`SEED_STAGE_NAME` comes from
 * DEFAULT_LAMBDA_ENVIRONMENT in infra/constants.ts) - a CLI, self-host, or test
 * run has no CloudWatch to publish to.
 */
export async function recordReplSandboxUnavailable(caller: ReplSandboxCaller, logger?: ILogger): Promise<void> {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  try {
    // Fresh client per call: warm Lambda containers outlive their credentials,
    // and a module-level client captures expired ones (see server/utils/cloudwatch.ts).
    const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    const timestamp = new Date();

    await client.send(
      new PutMetricDataCommand({
        Namespace: REPL_SANDBOX_NAMESPACE,
        MetricData: [
          // A CloudWatch alarm matches one exact dimension set, so the
          // Stage-only datapoint is the alarmable one; the Caller set exists so
          // the notification can be traced to a route without a log dive. They
          // are separate metrics to CloudWatch, so neither double-counts.
          {
            MetricName: SANDBOX_UNAVAILABLE_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            Dimensions: [{ Name: 'Stage', Value: stage }],
          },
          {
            MetricName: SANDBOX_UNAVAILABLE_METRIC,
            Value: 1,
            Unit: StandardUnit.Count,
            Timestamp: timestamp,
            Dimensions: [
              { Name: 'Stage', Value: stage },
              { Name: 'Caller', Value: caller },
            ],
          },
        ],
      })
    );
  } catch (error) {
    (logger ?? Logger.globalInstance).warn('[repl-sandbox] Failed to emit SandboxUnavailable metric', {
      caller,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
