import { describe, expect, it, vi } from 'vitest';
import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';
import { createSpendPost } from './slackPost';

const message: SlackAlarmMessage = { text: 'Spend warning', blocks: [] };

describe('createSpendPost', () => {
  it('sends to Slack when enabled', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await createSpendPost(true, send, { log: vi.fn() })(message);
    expect(send).toHaveBeenCalledWith(message);
  });

  it('logs and resolves without sending when disabled', async () => {
    const send = vi.fn();
    const log = vi.fn();
    await expect(createSpendPost(false, send, { log })(message)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('spend-monitor-slack-disabled', { text: 'Spend warning' });
  });
});
