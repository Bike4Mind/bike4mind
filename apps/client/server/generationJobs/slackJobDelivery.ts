import {
  TERMINAL_GENERATION_JOB_STATES,
  videoFileExtension,
  type GenerationJobDelivery,
  type GenerationJobErrorCode,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type VideoJobOutput,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

// Slack accepts far larger files, but the whole clip is buffered in the job worker before the upload.
export const SLACK_VIDEO_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const SLACK_VIDEO_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

type SlackDelivery = Extract<GenerationJobDelivery, { kind: 'slack' }>;

/** The slice of SlackClient this module uses, so tests need no Slack package. */
export type SlackPoster = {
  sendMessage(params: { channel: string; text: string; threadTs?: string }): Promise<string | null>;
  uploadFile(params: {
    channel: string;
    filename: string;
    content: Buffer;
    threadTs?: string;
    initialComment?: string;
  }): Promise<{ success: boolean }>;
};

export type SlackJobDeliveryDeps = {
  /** Null when the workspace or its token is unusable. */
  getSlackClient(workspaceId: string): Promise<SlackPoster | null>;
  downloadOutput(output: VideoJobOutput): Promise<Buffer>;
  signOutputUrl(output: VideoJobOutput, expiresInSeconds: number): Promise<string>;
  logger: Logger;
};

// A Slack thread is visible to the whole channel, so a job's own error text (provider exception messages,
// configuration details) is never posted: only these fixed reasons are.
const FAILURE_REASONS: Partial<Record<GenerationJobErrorCode, string>> = {
  provider_timeout: 'the provider did not finish in time',
  output_too_large: 'the clip was too large to store',
  input_image_not_found: 'the input image could not be found',
  region_unavailable: 'the model is not available in this region',
};

const failureText = (job: IGenerationJobDocumentOf<'video'>): string => {
  if (job.state === 'cancelled') return 'Video generation was cancelled.';
  if (job.state === 'blocked') return 'Video generation was blocked by the content policy. Try rewording your request.';
  const reason = job.error && FAILURE_REASONS[job.error.code];
  return reason ? `Video generation failed: ${reason}.` : 'Video generation failed. Please try again.';
};

const post = async (
  client: SlackPoster,
  job: IGenerationJobDocument,
  target: SlackDelivery,
  text: string,
  deps: SlackJobDeliveryDeps
) => {
  // sendMessage reports a failure (an open circuit breaker included) as null rather than throwing.
  const ts = await client.sendMessage({ channel: target.channelId, threadTs: target.threadTs, text });
  if (ts === null) deps.logger.warn('slack video message was not delivered', { jobId: job.id });
};

const deliverClip = async (
  job: IGenerationJobDocumentOf<'video'>,
  output: VideoJobOutput,
  target: SlackDelivery,
  client: SlackPoster,
  deps: SlackJobDeliveryDeps
) => {
  if (output.bytes <= SLACK_VIDEO_UPLOAD_MAX_BYTES) {
    try {
      const uploaded = await client.uploadFile({
        channel: target.channelId,
        filename: `video-${job.id}.${videoFileExtension(output.contentType) ?? 'mp4'}`,
        content: await deps.downloadOutput(output),
        threadTs: target.threadTs,
        initialComment: 'Your video is ready.',
      });
      if (uploaded.success) return;
      deps.logger.warn('slack video upload was rejected; falling back to a link', { jobId: job.id });
    } catch (error) {
      deps.logger.warn('slack video upload failed; falling back to a link', { jobId: job.id, error });
    }
  }
  try {
    const url = await deps.signOutputUrl(output, SLACK_VIDEO_LINK_TTL_SECONDS);
    // No duration is promised: a URL signed with the worker's temporary credentials can stop working sooner than
    // the TTL requested above.
    await post(client, job, target, `Your video is ready: <${url}|Download video> (the link is time-limited).`, deps);
  } catch (error) {
    deps.logger.error('slack video link delivery failed', { jobId: job.id, error });
    await post(
      client,
      job,
      target,
      'Your video is ready, but I could not post it here. You can find it in Bike4Mind.',
      deps
    );
  }
};

/**
 * Posts a finished video job back to the Slack thread that asked for it: the clip itself when it fits the upload
 * cap, a presigned link otherwise, and a plain message for a failed, blocked or cancelled job. A no-op for any
 * other job. The engine notifies a terminal job once, so this does not de-duplicate.
 */
export async function deliverJobToSlack(job: IGenerationJobDocument, deps: SlackJobDeliveryDeps): Promise<void> {
  if (job.kind !== 'video' || job.delivery?.kind !== 'slack') return;
  if (!TERMINAL_GENERATION_JOB_STATES.includes(job.state)) return;

  const client = await deps.getSlackClient(job.delivery.workspaceId);
  if (!client) {
    deps.logger.warn('slack video delivery skipped: workspace unavailable', { jobId: job.id });
    return;
  }

  const { output } = job.payload;
  if (job.state === 'succeeded' && output) {
    await deliverClip(job, output, job.delivery, client, deps);
    return;
  }
  await post(client, job, job.delivery, failureText(job), deps);
}
