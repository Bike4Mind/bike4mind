/**
 * Pure spec builder for the standard per-DLQ CloudWatch alarm pair (message
 * count + message age). Extracts the alarm-shape knowledge from each product's
 * dlqAlarms.ts builder loop; the product supplies only the resource-bound
 * pieces (queue dimensions, SNS alarm actions) when constructing
 * `new aws.cloudwatch.MetricAlarm(spec.resourceName, { ...spec.args, ... })`.
 *
 * Missing data is `'ignore'`, which holds the current alarm state. `'notBreaching'` scored a
 * skipped SQS datapoint as a passing period, so a gap flipped ALARM to OK and the next real
 * datapoint re-fired it, re-paging the same dead letter; `'missing'` is no better, because a
 * range with no datapoints at all still leaves ALARM for INSUFFICIENT_DATA and back.
 *
 * SQS publishes ApproximateAgeOfOldestMessage only while the queue holds a message, so the age
 * alarm reads it through metric math, `IF(visible > 0, age, 0)`. An empty queue scores 0 and
 * still resolves to OK; a gap while a message is present scores nothing and holds state.
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

export type DlqAlarmKind = 'messages' | 'age';

/** One query of an alarm's metric math (structurally a Pulumi MetricAlarmMetricQuery). */
export interface DlqAlarmMetricQuery {
  id: string;
  label?: string;
  expression?: string;
  returnData?: boolean;
  metric?: {
    namespace: string;
    metricName: string;
    /** Filled in by the product, which owns the queue. */
    dimensions?: Record<string, string>;
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

/**
 * Builds the standard [message-count, message-age] alarm spec pair for one DLQ.
 * Names and thresholds match the shape long deployed from infra/dlqAlarms.ts,
 * so adopting this builder is a zero-diff refactor for existing alarms.
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
        // SQS stops publishing the age metric once the queue is empty, so scoring the raw
        // metric would strand every drained DLQ in INSUFFICIENT_DATA instead of OK.
        metricQueries: [
          {
            id: 'visible',
            metric: {
              namespace: 'AWS/SQS',
              metricName: 'ApproximateNumberOfMessagesVisible',
              period: defaults.agePeriod,
              stat: 'Maximum',
            },
            returnData: false,
          },
          {
            id: 'age',
            metric: {
              namespace: 'AWS/SQS',
              metricName: 'ApproximateAgeOfOldestMessage',
              period: defaults.agePeriod,
              stat: 'Maximum',
            },
            returnData: false,
          },
          {
            id: 'oldest',
            label: 'Oldest message age (0 when the queue is empty)',
            expression: 'IF(visible > 0, age, 0)',
            returnData: true,
          },
        ],
        tags: {
          Application: dlq.application,
          Severity: 'High',
          MonitoringType: 'DLQ',
        },
      },
    },
  ];
}
