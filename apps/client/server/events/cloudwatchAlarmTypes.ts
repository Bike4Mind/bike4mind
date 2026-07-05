/**
 * Shared CloudWatch alarm payload types for SNS-triggered alarm handlers.
 */

export interface CloudWatchAlarmPayload {
  AlarmName: string;
  AlarmDescription?: string;
  NewStateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  OldStateValue: string;
  NewStateReason: string;
  StateChangeTime: string;
  Region: string;
}
