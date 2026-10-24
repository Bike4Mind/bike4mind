import { describe, expect, it, vi } from 'vitest';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import { buildSlackVideoToolConfig, SLACK_VIDEO_DELIVERY_NOTE } from './slackVideoToolConfig';

const notification = {
  workspaceId: 'w1',
  channelId: 'C1',
  messageTs: '1700000000.000200',
  threadTs: '1700000000.000100',
};

const makeDeps = (found: typeof notification | null, config: VideoToolConfig | null) => ({
  findSlackNotification: vi.fn().mockResolvedValue(found),
  buildConfig: vi.fn().mockResolvedValue(config),
});

describe('buildSlackVideoToolConfig', () => {
  it('does not offer the tool, or look up models, when the quest has no pending Slack notification', async () => {
    const deps = makeDeps(null, { usableModels: ['test-video'], createJob: vi.fn() });
    await expect(buildSlackVideoToolConfig('q1', 'u1', deps)).resolves.toBeNull();
    expect(deps.buildConfig).not.toHaveBeenCalled();
  });

  it('does not offer the tool when the caller has no usable video model', async () => {
    const deps = makeDeps(notification, null);
    await expect(buildSlackVideoToolConfig('q1', 'u1', deps)).resolves.toBeNull();
  });

  it('stamps the requesting thread on every job and carries the delivery note', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps(notification, { usableModels: ['test-video'], createJob });
    const config = await buildSlackVideoToolConfig('q1', 'u1', deps);
    await config?.createJob({ user: { id: 'u1', organizationId: null }, request: {}, source: 'agent', questId: 'q1' });
    expect(deps.findSlackNotification).toHaveBeenCalledWith('q1');
    expect(deps.buildConfig).toHaveBeenCalledWith('u1');
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: { kind: 'slack', workspaceId: 'w1', channelId: 'C1', threadTs: notification.threadTs },
      })
    );
    expect(config?.deliveryNote).toBe(SLACK_VIDEO_DELIVERY_NOTE);
  });

  it('threads under the triggering message when the request was not in a thread', async () => {
    const { threadTs: _unused, ...topLevel } = notification;
    const createJob = vi.fn().mockResolvedValue({ ok: true });
    const config = await buildSlackVideoToolConfig(
      'q1',
      'u1',
      makeDeps(topLevel as typeof notification, { usableModels: ['test-video'], createJob })
    );
    await config?.createJob({ user: { id: 'u1', organizationId: null }, request: {}, source: 'agent' });
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ threadTs: notification.messageTs }) })
    );
  });
});
