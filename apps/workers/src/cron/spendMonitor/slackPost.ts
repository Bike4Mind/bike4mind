import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';

type Logger = { log: (...args: unknown[]) => void };

/**
 * A disabled integration resolves like a successful post, so shadow-phase incident history (including
 * lastNotifiedValue, which gates escalation) matches what live Slack would have produced.
 */
export function createSpendPost(
  slackEnabled: boolean,
  sendToSlack: (message: SlackAlarmMessage) => Promise<void>,
  logger: Logger
): (message: SlackAlarmMessage) => Promise<void> {
  if (slackEnabled) return sendToSlack;
  return async message => {
    logger.log('spend-monitor-slack-disabled', { text: message.text });
  };
}
