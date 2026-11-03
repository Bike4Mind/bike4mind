/**
 * Pure spec builder for the standard per-DLQ CloudWatch alarm pair (message
 * count + message age). Extracts the alarm-shape knowledge from each product's
 * dlqAlarms.ts builder loop; the product supplies the SNS alarm actions and
 * binds its queue by spreading `bindDlqAlarmDimensions(spec, dimensions)`:
 *
 *   new aws.cloudwatch.MetricAlarm(spec.resourceName, {
 *     ...spec.args,
 *     ...bindDlqAlarmDimensions(spec, { QueueName: dlq.queue.nodes.queue.name }),
 *     alarmActions: [topic.arn],
 *     okActions: [topic.arn],
 *   });
 *
 * An age spec is metric math, and CloudWatch rejects the alarm-level metric fields alongside
 * `metricQueries`, so its dimensions belong on the input queries only - the helper puts them
 * wherever the spec's kind needs them.
 *
 * Missing data is `'ignore'`, which holds the current alarm state. `'notBreaching'` scored a
 * skipped SQS datapoint as a passing period, so a gap flipped ALARM to OK and the next real
 * datapoint re-fired it, re-paging the same dead letter; `'missing'` is no better, because a
 * range with no datapoints at all still leaves ALARM for INSUFFICIENT_DATA and back.
 *
 * SQS publishes ApproximateAgeOfOldestMessage only while the queue holds a message, so the age
 * alarm reads it through metric math, `IF(visible > 0, age, 0)`. SQS reports metrics while a
 * queue is active, so a recently-drained DLQ normally reports 0 visible and the alarm reaches OK;
 * the post-deploy drain check is what confirms that on a real queue. A range with no datapoint at
 * all drops the expression, which `'ignore'` holds.
 *
 * Two known residuals, one per direction of a partial gap:
 * - `visible > 0` with no `age`: IF's documented missing-data rule scores the true branch 0, a
 *   passing datapoint, so the age alarm can still walk ALARM -> OK -> ALARM and re-page on the
 *   next age datapoint.
 * - `age` present with no `visible`: IF drops its output when the condition series has no
 *   datapoint, so that period is not evaluated and `'ignore'` holds whatever state the alarm was
 *   in - an alarm in ALARM stays there, but one in OK does not see the breach until the condition
 *   returns.
 * Closing either direction needs `FILL(age, REPEAT)`, whose documented delayed-publish behaviour
 * can pin an evaluation-periods-1 alarm unless it also moves to M-of-N; not worth that trade for
 * these narrower gaps.
 */

export interface DlqAlarmDefaults {
  /** Message-count alarm fires above this many visible messages. */
  messageThreshold: number;
  /** Consecutive breaching periods before the message-count alarm fires. */
  messageEvalPeriods: number;
  /** Message-count alarm evaluation period in seconds. */
  messagePeriod: number;
  /** Age alarm fires when the oldest message exceeds this many seconds. */
  ageThreshold: number;
  /** Age alarms keep eval=1 (the age threshold already provides built-in delay). */
  ageEvalPeriods: number;
  /** Age alarm evaluation period in seconds. */
  agePeriod: number;
}

export const DLQ_ALARM_DEFAULTS: DlqAlarmDefaults = {
  messageThreshold: 0,
  messageEvalPeriods: 3,
  messagePeriod: 60,
  ageThreshold: 3600,
  ageEvalPeriods: 1,
  agePeriod: 300,
};

export interface DlqAlarmDescriptor {
  /** Short kebab-case label used in alarm names, e.g. 'image-generation'. */
  label: string;
  /** Human-readable name used in alarm descriptions. */
  displayName: string;
  /** Value of the Application tag for CloudWatch grouping. */
  application: string;
  /** Override message count alarm evaluation periods. */
  messageEvalPeriods?: number;
  /** Override message count alarm threshold. */
  messageThreshold?: number;
  /** Override message age alarm threshold in seconds. */
  ageThreshold?: number;
}

export interface DlqAlarmNaming {
  /** App name, e.g. $app.name. */
  appName: string;
  /** Deploy stage, e.g. $app.stage. */
  stage: string;
}

/**
 * One query of an alarm's metric math (structurally a Pulumi MetricAlarmMetricQuery).
 * `Dimension` is the dimension value type a consumer binds, so Pulumi outputs pass through
 * without a cast; the unbound spec in `buildDlqAlarmSpecs` uses the `string` default.
 */
export interface DlqAlarmMetricQuery<Dimension = string> {
  id: string;
  label?: string;
  expression?: string;
  returnData?: boolean;
  metric?: {
    namespace: string;
    metricName: string;
    /** Bound by `bindDlqAlarmDimensions`, because only the product knows its queue. */
    dimensions?: Record<string, Dimension>;
    period: number;
    stat: 'Maximum';
  };
}

interface DlqAlarmBaseArgs {
  name: string;
  alarmDescription: string;
  comparisonOperator: 'GreaterThanThreshold';
  evaluationPeriods: number;
  threshold: number;
  /** Holds the current state across an SQS metric gap instead of resolving the alarm. */
  treatMissingData: 'ignore';
  tags: {
    Application: string;
    Severity: 'Critical' | 'High';
    MonitoringType: 'DLQ';
  };
}

/** Everything about the alarm derivable without touching cloud resources. */
export type DlqAlarmSpec =
  | {
      kind: 'messages';
      /** Pulumi/SST logical resource name, e.g. 'dlq-image-generation-messages'. */
      resourceName: string;
      /** MetricAlarm args minus the resource-bound fields (dimensions, actions). */
      args: DlqAlarmBaseArgs & {
        metricName: 'ApproximateNumberOfMessagesVisible';
        namespace: 'AWS/SQS';
        period: number;
        statistic: 'Maximum';
      };
    }
  | {
      kind: 'age';
      resourceName: string;
      args: DlqAlarmBaseArgs & {
        metricQueries: DlqAlarmMetricQuery[];
      };
    };

/** Derived from the spec union, so a new kind cannot leave this union behind. */
export type DlqAlarmKind = DlqAlarmSpec['kind'];

/**
 * Binds the owning queue to the fields a spec's shape keeps its dimensions in: a flat messages
 * alarm takes alarm-level `dimensions`, a metric-math age alarm takes them on every input metric.
 * Spread the result into the MetricAlarm args. `Dimension` is generic so a product can pass the
 * Pulumi outputs its queue exposes (`Output<string>`) exactly as it can pass plain strings.
 */
export function bindDlqAlarmDimensions<Dimension>(
  spec: DlqAlarmSpec,
  dimensions: Record<string, Dimension>
): { dimensions: Record<string, Dimension> } | { metricQueries: DlqAlarmMetricQuery<Dimension>[] } {
  if (spec.kind === 'messages') return { dimensions };
  return {
    metricQueries: spec.args.metricQueries.map(({ metric, ...query }) =>
      metric ? { ...query, metric: { ...metric, dimensions } } : query
    ),
  };
}

/**
 * The age alarm's metric math, `IF(visible > 0, age, 0)` (see the file header for why and its
 * residuals). Shared by the fleet spec and the out-of-band DLQ alarms in infra/dlqAlarms.ts and
 * infra/waf.ts; pass `dimensions` to bind the queue directly, or leave them for
 * `bindDlqAlarmDimensions`.
 */
export function buildDlqAgeMetricQueries<Dimension = string>(
  period: number,
  dimensions?: Record<string, Dimension>
): DlqAlarmMetricQuery<Dimension>[] {
  const input = (id: string, metricName: string): DlqAlarmMetricQuery<Dimension> => ({
    id,
    metric: { namespace: 'AWS/SQS', metricName, ...(dimensions && { dimensions }), period, stat: 'Maximum' },
    returnData: false,
  });
  return [
    input('visible', 'ApproximateNumberOfMessagesVisible'),
    input('age', 'ApproximateAgeOfOldestMessage'),
    {
      id: 'oldest',
      label: 'Oldest message age (0 when the queue is empty)',
      expression: 'IF(visible > 0, age, 0)',
      returnData: true,
    },
  ];
}

/**
 * Builds the standard [message-count, message-age] alarm spec pair for one DLQ.
 * Names and thresholds match the shape long deployed from infra/dlqAlarms.ts. The age spec is
 * metric math, so a consumer must bind its queue with `bindDlqAlarmDimensions` (see the file
 * header) rather than spreading alarm-level `dimensions`.
 */
export function buildDlqAlarmSpecs(
  dlq: DlqAlarmDescriptor,
  naming: DlqAlarmNaming,
  defaults: DlqAlarmDefaults = DLQ_ALARM_DEFAULTS
): [DlqAlarmSpec, DlqAlarmSpec] {
  if (!dlq.label) throw new Error('buildDlqAlarmSpecs: descriptor label is required');
  const prefix = `${naming.appName}-${naming.stage}-dlq-${dlq.label}`;

  return [
    {
      kind: 'messages',
      resourceName: `dlq-${dlq.label}-messages`,
      args: {
        name: `${prefix}-messages`,
        alarmDescription: `${dlq.displayName} DLQ has messages - processing failures detected`,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: dlq.messageEvalPeriods ?? defaults.messageEvalPeriods,
        metricName: 'ApproximateNumberOfMessagesVisible',
        namespace: 'AWS/SQS',
        period: defaults.messagePeriod,
        statistic: 'Maximum',
        threshold: dlq.messageThreshold ?? defaults.messageThreshold,
        treatMissingData: 'ignore',
        tags: {
          Application: dlq.application,
          Severity: 'Critical',
          MonitoringType: 'DLQ',
        },
      },
    },
    {
      kind: 'age',
      resourceName: `dlq-${dlq.label}-age`,
      args: {
        name: `${prefix}-age`,
        alarmDescription: `${dlq.displayName} DLQ has message stuck for >1 hour`,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: defaults.ageEvalPeriods,
        threshold: dlq.ageThreshold ?? defaults.ageThreshold,
        treatMissingData: 'ignore',
        metricQueries: buildDlqAgeMetricQueries(defaults.agePeriod),
        tags: {
          Application: dlq.application,
          Severity: 'High',
          MonitoringType: 'DLQ',
        },
      },
    },
  ];
}
