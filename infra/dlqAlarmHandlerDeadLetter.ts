import { isMonitoredStage } from '@bike4mind/infra';

export const dlqAlarmHandlerDlq = isMonitoredStage($app.stage, ['dev', 'production'], process.env.ENABLE_MONITORING)
  ? new aws.sqs.Queue('DlqAlarmHandlerDlq', { messageRetentionSeconds: 14 * 24 * 3600 })
  : undefined;
