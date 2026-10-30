import { describe, expect, it, vi } from 'vitest';
import { GENERATION_JOB_ERROR_CODES, type IGenerationJobDocument } from '@bike4mind/common';
import {
  deliverJobToSlack,
  SCAN_WAIT_ATTEMPTS,
  SCAN_WAIT_INTERVAL_MS,
  SLACK_VIDEO_LINK_TTL_SECONDS,
  SLACK_VIDEO_UPLOAD_MAX_BYTES,
  type SlackJobDeliveryDeps,
  type SlackPoster,
} from './slackJobDelivery';

const delivery = { kind: 'slack' as const, workspaceId: 'w1', channelId: 'C1', threadTs: '1700000000.000100' };
const output = {
  location: 'files' as const,
  s3Key: 'clips/job1.mp4',
  contentType: 'video/mp4',
  bytes: 1024,
  durationSeconds: 8,
};

const job = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'job1',
    kind: 'video',
    state: 'succeeded',
    delivery,
    payload: { output },
    ...overrides,
  }) as unknown as IGenerationJobDocument;

const build = (client: Partial<SlackPoster> | null = {}) => {
  const poster: SlackPoster = {
    sendMessage: vi.fn().mockResolvedValue('ts'),
    uploadFile: vi.fn().mockResolvedValue({ success: true }),
    ...client,
  };
  const deps: SlackJobDeliveryDeps = {
    getSlackClient: vi.fn().mockResolvedValue(client === null ? null : poster),
    downloadOutput: vi.fn().mockResolvedValue(Buffer.from('clip')),
    signOutputUrl: vi.fn().mockResolvedValue({ availability: 'ready', url: 'https://example.test/clip.mp4' }),
    sleep: vi.fn().mockResolvedValue(undefined),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
  };
  return { poster, deps };
};

describe('deliverJobToSlack', () => {
  it('uploads the clip into the requesting thread when it fits the cap', async () => {
    const { poster, deps } = build();
    await deliverJobToSlack(job(), deps);
    expect(poster.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        threadTs: delivery.threadTs,
        filename: 'video-job1.mp4',
        content: Buffer.from('clip'),
      })
    );
    expect(poster.sendMessage).not.toHaveBeenCalled();
  });

  it('posts a link without downloading when the clip is over the upload cap', async () => {
    const { poster, deps } = build();
    const big = job({ payload: { output: { ...output, bytes: SLACK_VIDEO_UPLOAD_MAX_BYTES + 1 } } });
    await deliverJobToSlack(big, deps);
    expect(deps.downloadOutput).not.toHaveBeenCalled();
    expect(deps.signOutputUrl).toHaveBeenCalledWith(expect.anything(), SLACK_VIDEO_LINK_TTL_SECONDS);
    expect(poster.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        threadTs: delivery.threadTs,
        text: expect.stringContaining('<https://'),
      })
    );
  });

  it('falls back to a link when the upload throws', async () => {
    const { poster, deps } = build({ uploadFile: vi.fn().mockRejectedValue(new Error('slack down')) });
    await deliverJobToSlack(job(), deps);
    expect(poster.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Download video') })
    );
  });

  it('falls back to a link when Slack rejects the upload', async () => {
    const { poster, deps } = build({ uploadFile: vi.fn().mockResolvedValue({ success: false }) });
    await deliverJobToSlack(job(), deps);
    expect(poster.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Download video') })
    );
  });

  it.each(['unavailable', 'pending_scan'] as const)(
    'withholds the old link when a failed download is followed by %s',
    async availability => {
      const { poster, deps } = build();
      vi.mocked(deps.downloadOutput).mockRejectedValue(new Error('generation output is not serveable'));
      vi.mocked(deps.signOutputUrl)
        .mockResolvedValueOnce({ availability: 'ready', url: 'https://example.test/old.mp4' })
        .mockResolvedValue({ availability });
      await deliverJobToSlack(job(), deps);
      expect(poster.uploadFile).not.toHaveBeenCalled();
      expect(poster.sendMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: expect.stringContaining('could not post it here') })
      );
      expect(vi.mocked(poster.sendMessage).mock.calls[0][0].text).not.toContain('https://');
    }
  );

  it('uses a fresh gated URL after an upload failure', async () => {
    const { poster, deps } = build({ uploadFile: vi.fn().mockResolvedValue({ success: false }) });
    vi.mocked(deps.signOutputUrl)
      .mockResolvedValueOnce({ availability: 'ready', url: 'https://example.test/old.mp4' })
      .mockResolvedValueOnce({ availability: 'ready', url: 'https://example.test/fresh.mp4' });
    await deliverJobToSlack(job(), deps);
    expect(poster.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: expect.stringContaining('<https://example.test/fresh.mp4|') })
    );
  });

  it('withholds the old link if the fallback moderation lookup fails', async () => {
    const { poster, deps } = build({ uploadFile: vi.fn().mockRejectedValue(new Error('upload failed')) });
    vi.mocked(deps.signOutputUrl)
      .mockResolvedValueOnce({ availability: 'ready', url: 'https://example.test/old.mp4' })
      .mockRejectedValueOnce(new Error('moderation lookup failed'));
    await deliverJobToSlack(job(), deps);
    expect(poster.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: expect.stringContaining('could not post it here') })
    );
  });

  it('falls back to the could-not-post message when the moderation gate throws', async () => {
    const { poster, deps } = build();
    vi.mocked(deps.signOutputUrl).mockRejectedValue(new Error('no signer'));
    await deliverJobToSlack(job(), deps);
    expect(poster.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('could not post it here') })
    );
  });

  it('waits for the moderation scan, then uploads the clip', async () => {
    const { poster, deps } = build();
    vi.mocked(deps.signOutputUrl)
      .mockResolvedValueOnce({ availability: 'pending_scan' })
      .mockResolvedValueOnce({ availability: 'pending_scan' })
      .mockResolvedValue({ availability: 'ready', url: 'https://example.test/clip.mp4' });
    await deliverJobToSlack(job(), deps);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(SCAN_WAIT_INTERVAL_MS);
    expect(poster.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('gives up after the wait budget and says the clip could not be posted, without touching the bytes', async () => {
    const { poster, deps } = build();
    vi.mocked(deps.signOutputUrl).mockResolvedValue({ availability: 'pending_scan' });
    await deliverJobToSlack(job(), deps);
    expect(deps.signOutputUrl).toHaveBeenCalledTimes(SCAN_WAIT_ATTEMPTS);
    expect(deps.downloadOutput).not.toHaveBeenCalled();
    expect(poster.uploadFile).not.toHaveBeenCalled();
    expect(poster.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('could not post it here') })
    );
  });

  it('never uploads or links an output that failed moderation or is gone', async () => {
    const { poster, deps } = build();
    vi.mocked(deps.signOutputUrl).mockResolvedValue({ availability: 'unavailable' });
    await deliverJobToSlack(job(), deps);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.downloadOutput).not.toHaveBeenCalled();
    expect(poster.uploadFile).not.toHaveBeenCalled();
    expect(poster.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "I could not post it here. Check your video's status in Bike4Mind." })
    );
  });

  it.each([
    [
      'failed',
      { error: { code: 'provider_timeout', message: 'x' } },
      'Video generation failed: the provider did not finish in time.',
    ],
    ['failed', { error: { code: 'provider_error', message: 'x' } }, 'Video generation failed. Please try again.'],
    ['failed', {}, 'Video generation failed. Please try again.'],
    [
      'blocked',
      { error: { code: 'content_blocked', message: 'x' } },
      'Video generation was blocked by the content policy. Try rewording your request.',
    ],
    ['cancelled', {}, 'Video generation was cancelled.'],
  ])('posts a fixed message for a %s job', async (state, extra, text) => {
    const { poster, deps } = build();
    await deliverJobToSlack(job({ state, payload: {}, ...extra }), deps);
    expect(poster.sendMessage).toHaveBeenCalledWith({ channel: 'C1', threadTs: delivery.threadTs, text });
    expect(poster.uploadFile).not.toHaveBeenCalled();
  });

  it.each([...GENERATION_JOB_ERROR_CODES, undefined])(
    "never posts the job's own error text into the thread (error code %s)",
    async code => {
      const { poster, deps } = build();
      const leaky = 'connect ECONNREFUSED 10.0.0.1:443 <!channel> No API key configured for veo';
      await deliverJobToSlack(
        job({ state: 'failed', payload: {}, ...(code && { error: { code, message: leaky } }) }),
        deps
      );
      const { text } = vi.mocked(poster.sendMessage).mock.calls[0][0];
      expect(text).toMatch(/^Video generation failed/);
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('<!channel>');
      expect(text).not.toContain('veo');
    }
  );

  it('does not promise a link lifetime', async () => {
    const { poster, deps } = build();
    await deliverJobToSlack(job({ payload: { output: { ...output, bytes: SLACK_VIDEO_UPLOAD_MAX_BYTES + 1 } } }), deps);
    expect(vi.mocked(poster.sendMessage).mock.calls[0][0].text).not.toMatch(/\b7 days\b/);
  });

  it('logs when Slack does not accept a notice, since nothing else will tell the user', async () => {
    const { deps } = build({ sendMessage: vi.fn().mockResolvedValue(null) });
    await deliverJobToSlack(job({ state: 'cancelled', payload: {} }), deps);
    expect(deps.logger.warn).toHaveBeenCalledWith('slack video message was not delivered', { jobId: 'job1' });
  });

  it.each(['pending', 'running', 'storing'])('does nothing while the job is %s', async state => {
    const { deps } = build();
    await deliverJobToSlack(job({ state }), deps);
    expect(deps.getSlackClient).not.toHaveBeenCalled();
  });

  it('does nothing for a job with no delivery target or of another kind', async () => {
    const { deps } = build();
    await deliverJobToSlack(job({ delivery: undefined }), deps);
    await deliverJobToSlack(job({ kind: 'music' }), deps);
    expect(deps.getSlackClient).not.toHaveBeenCalled();
  });

  it('skips quietly when the workspace is unavailable', async () => {
    const { deps } = build(null);
    await expect(deliverJobToSlack(job(), deps)).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
