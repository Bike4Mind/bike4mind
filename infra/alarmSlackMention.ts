/**
 * Per-stage Slack mention setting for the alarm relays (apps/workers/src/events/alarmSlackMention.ts
 * reads it). An SSM parameter, not a secret, so an operator can turn the production page mention
 * on or off with `aws ssm put-parameter --overwrite` and no deploy; the value is ignored after
 * creation for that reason. Accepted values: off, channel, here, a user id, a user-group id, or a
 * raw token such as <!subteam^S0123>.
 */

import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

export const alarmSlackMentionParameterName = `/${$app.name}/${$app.stage}/alarm-slack-mention`;

export const alarmSlackMentionParameter = isMonitoredStage
  ? new aws.ssm.Parameter(
      'AlarmSlackMention',
      {
        name: alarmSlackMentionParameterName,
        type: 'String',
        value: 'off',
        description:
          'Slack mention token prepended to production page-level alarms (off, channel, here, user or group id)',
      },
      { ignoreChanges: ['value'] }
    )
  : undefined;

/** Function args that let an alarm relay find and read the parameter. Empty on unmonitored stages. */
export function alarmSlackMentionFunctionArgs(): {
  environment: Record<string, string>;
  permissions: { actions: string[]; resources: $util.Input<string>[] }[];
} {
  if (!alarmSlackMentionParameter) return { environment: {}, permissions: [] };
  return {
    environment: { ALARM_SLACK_MENTION_PARAMETER: alarmSlackMentionParameterName },
    permissions: [{ actions: ['ssm:GetParameter'], resources: [alarmSlackMentionParameter.arn] }],
  };
}
