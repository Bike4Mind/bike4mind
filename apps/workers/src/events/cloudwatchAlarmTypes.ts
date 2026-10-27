/**
 * Shared CloudWatch alarm payload types for SNS-triggered alarm handlers.
 */

export interface CloudWatchAlarmTrigger {
  MetricName?: string;
  Namespace?: string;
  Statistic?: string;
  /** Seconds. */
  Period?: number;
  Threshold?: number;
  ComparisonOperator?: string;
  EvaluationPeriods?: number;
  DatapointsToAlarm?: number;
  TreatMissingData?: string;
  Dimensions?: { name: string; value: string }[];
}

export interface CloudWatchAlarmPayload {
  AlarmName: string;
  AlarmDescription?: string;
  NewStateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  OldStateValue: string;
  NewStateReason: string;
  StateChangeTime: string;
  /** Absent on hand-shaped SNS messages. */
  Region?: string;
  AWSAccountId?: string;
  AlarmArn?: string;
  Trigger?: CloudWatchAlarmTrigger;
}
