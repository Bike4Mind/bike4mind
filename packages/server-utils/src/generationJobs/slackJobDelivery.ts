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
import type { GroupCompletion, GroupCompletionSubscriber } from '@bike4mind/services/generationJobs';
import type { SignedOutput, StoredOutputRef } from '../generations/signedOutput';

// Slack accepts far larger files, but the whole output is buffered in the job worker before the upload.
export const SLACK_OUTPUT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const SLACK_OUTPUT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

// A clip saved to Files is created `pending` and only turns serveable once the async S3 scan runs (typically a
// second or two), so a job can notify as succeeded before its file may be served.
export const SCAN_WAIT_ATTEMPTS = 8;
export const SCAN_WAIT_INTERVAL_MS = 1500;

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
  /** Throws unless the output is serveable (the moderation gate). */
  downloadOutput(output: StoredOutputRef): Promise<Buffer>;
  /** Behind the same moderation gate: a url only when the output may be served. */
  signOutputUrl(output: StoredOutputRef, expiresInSeconds: number): Promise<SignedOutput>;
  /** An app link that re-checks `userId`'s access when clicked; null when the output cannot be linked. */
  buildOutputLink(output: StoredOutputRef, userId: string, ttlSeconds: number): string | null;
  sleep(ms: number): Promise<void>;
  logger: Logger;
};

type Medium = 'video' | 'image';

// What each medium's output is called in the fixed texts below ("clip" is only used for the size reason).
const MEDIUM_NOUNS: Record<Medium, { name: string; stored: string }> = {
  video: { name: 'video', stored: 'clip' },
  image: { name: 'image', stored: 'image' },
};

// A Slack thread is visible to the whole channel, so a job's own error text (provider exception messages,
// configuration details) is never posted: only these fixed reasons are.
const failureReason = (code: GenerationJobErrorCode, medium: Medium): string | undefined =>
  ({
    provider_timeout: 'the provider did not finish in time',
    output_too_large: `the ${MEDIUM_NOUNS[medium].stored} was too large to store`,
    input_image_not_found: 'the input image could not be found',
    region_unavailable: 'the model is not available in this region',
  })[code as string];

const failureText = (medium: Medium, job: IGenerationJobDocument): string => {
  const noun = `${MEDIUM_NOUNS[medium].name[0].toUpperCase()}${MEDIUM_NOUNS[medium].name.slice(1)} generation`;
  if (job.state === 'cancelled') return `${noun} was cancelled.`;
  if (job.state === 'blocked') return `${noun} was blocked by the content policy. Try rewording your request.`;
  const reason = job.error && failureReason(job.error.code, medium);
  return reason ? `${noun} failed: ${reason}.` : `${noun} failed. Please try again.`;
};

const notPostedText = (medium: Medium): string =>
  `I could not post it here. Check your ${MEDIUM_NOUNS[medium].name}'s status in Bike4Mind.`;

const post = async (
  client: SlackPoster,
  jobId: string,
  target: SlackDelivery,
  text: string,
  deps: SlackJobDeliveryDeps,
  medium: Medium
) => {
  // sendMessage reports a failure (an open circuit breaker included) as null rather than throwing.
  const ts = await client.sendMessage({ channel: target.channelId, threadTs: target.threadTs, text });
  if (ts === null) deps.logger.warn(`slack ${medium} message was not delivered`, { jobId });
};

const waitUntilServeable = async (output: StoredOutputRef, deps: SlackJobDeliveryDeps): Promise<SignedOutput> => {
  for (let attempt = 1; ; attempt++) {
    const signed = await deps.signOutputUrl(output, SLACK_OUTPUT_LINK_TTL_SECONDS);
    if (signed.availability !== 'pending_scan' || attempt >= SCAN_WAIT_ATTEMPTS) return signed;
    await deps.sleep(SCAN_WAIT_INTERVAL_MS);
  }
};

type DeliverableOutput = StoredOutputRef & { contentType: string; bytes: number };

type OutputPost = {
  jobId: string;
  requestedBy: string;
  output: DeliverableOutput;
  medium: Medium;
  filename: string;
  /** Rides on the upload, or prefixes the link message when the output goes out as a link. */
  comment?: string;
  linkLabel: string;
  /** The moderation wait, when the caller already ran it (a batch waits for all its images at once). */
  scan?: PromiseSettledResult<SignedOutput>;
};

/**
 * Posts one stored output into the thread: the file itself when it fits the upload cap, an app file link otherwise.
 * Behind the moderation gate throughout. Resolves false, having posted nothing, when the output cannot go out, so
 * the caller decides how to say so.
 */
const postOutput = async (
  item: OutputPost,
  target: SlackDelivery,
  client: SlackPoster,
  deps: SlackJobDeliveryDeps
): Promise<boolean> => {
  const { jobId, output, medium } = item;
  try {
    if (item.scan?.status === 'rejected') throw item.scan.reason;
    const signed = item.scan?.status === 'fulfilled' ? item.scan.value : await waitUntilServeable(output, deps);
    if (signed.availability !== 'ready') {
      deps.logger.warn(`slack ${medium} delivery skipped: the output is not serveable`, {
        jobId,
        availability: signed.availability,
      });
      return false;
    }
    if (output.bytes <= SLACK_OUTPUT_UPLOAD_MAX_BYTES) {
      try {
        const uploaded = await client.uploadFile({
          channel: target.channelId,
          filename: item.filename,
          content: await deps.downloadOutput(output),
          threadTs: target.threadTs,
          ...(item.comment && { initialComment: item.comment }),
        });
        if (uploaded.success) return true;
        deps.logger.warn(`slack ${medium} upload was rejected; falling back to a link`, { jobId });
      } catch (error) {
        deps.logger.warn(`slack ${medium} upload failed; falling back to a link`, { jobId, error });
      }
    }
    // An upload can fail because the download gate observed a deletion or moderation change.
    // Recheck before publishing a link rather than reusing the URL from before that failure.
    const fallback = await deps.signOutputUrl(output, SLACK_OUTPUT_LINK_TTL_SECONDS);
    if (fallback.availability !== 'ready') {
      deps.logger.warn(`slack ${medium} link skipped: the output is no longer serveable`, {
        jobId,
        availability: fallback.availability,
      });
      return false;
    }
    const link = deps.buildOutputLink(output, item.requestedBy, SLACK_OUTPUT_LINK_TTL_SECONDS);
    if (!link) {
      deps.logger.warn(`slack ${medium} link skipped: the output cannot be linked`, { jobId });
      return false;
    }
    const expiry = `(the link expires in ${SLACK_OUTPUT_LINK_TTL_SECONDS / 86400} days)`;
    const linkText = `<${link}|${item.linkLabel}> ${expiry}.`;
    await post(
      client,
      jobId,
      target,
      item.comment ? `${item.comment.replace(/\.$/, '')}: ${linkText}` : linkText,
      deps,
      medium
    );
    return true;
  } catch (error) {
    deps.logger.error(`slack ${medium} delivery failed`, { jobId, error });
    return false;
  }
};

const deliverClip = async (
  job: IGenerationJobDocumentOf<'video'>,
  output: VideoJobOutput,
  target: SlackDelivery,
  client: SlackPoster,
  deps: SlackJobDeliveryDeps
) => {
  const posted = await postOutput(
    {
      jobId: job.id,
      requestedBy: job.requestedBy,
      output,
      medium: 'video',
      filename: `video-${job.id}.${videoFileExtension(output.contentType) ?? 'mp4'}`,
      comment: 'Your video is ready.',
      linkLabel: 'Download video',
    },
    target,
    client,
    deps
  );
  if (!posted) await post(client, job.id, target, notPostedText('video'), deps, 'video');
};

/**
 * Posts a finished video job back to the Slack thread that asked for it: the clip itself when it fits the upload
 * cap, an app file link otherwise, and a plain message for a failed, blocked or cancelled job. A no-op for any
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
  await post(client, job.id, job.delivery, failureText('video', job), deps, 'video');
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The one closing message for a batch, or null when every image went out. Fixed texts only, as for video. */
const imageBatchSummary = (completion: GroupCompletion, notPosted: number): string | null => {
  const { members, readyCount, failedCount, cancelledCount } = completion;
  // Takes the user cancelled are not part of the batch, as in the push count.
  const wanted = members.length - cancelledCount;
  if (wanted === 1) {
    if (readyCount === 0) {
      const failed = members.find(member => member.state !== 'succeeded' && member.state !== 'cancelled');
      return failed ? failureText('image', failed) : null;
    }
    return notPosted > 0 ? notPostedText('image') : null;
  }
  if (readyCount === 0) return 'None of the images could be generated. Please try again.';
  const parts: string[] = [];
  if (failedCount > 0) parts.push(`${failedCount} of ${wanted} images could not be generated.`);
  if (notPosted > 0) parts.push(`I could not post ${notPosted} of them here. Check your images in Bike4Mind.`);
  return parts.length > 0 ? parts.join(' ') : null;
};

/**
 * Posts a finished "make N" image batch back to the Slack thread that asked for it, once for the whole batch: each
 * ready image (uploaded, or linked when it cannot be), then one closing message for whatever failed or could not be
 * posted. Driven by the group completion decision, so it never sees a batch twice.
 */
export async function deliverImageGroupToSlack(completion: GroupCompletion, deps: SlackJobDeliveryDeps): Promise<void> {
  const { anchor, members, readyCount } = completion;
  const target = anchor.delivery;
  if (target?.kind !== 'slack') return;

  const client = await deps.getSlackClient(target.workspaceId);
  if (!client) {
    deps.logger.warn('slack image delivery skipped: workspace unavailable', { jobId: anchor.id });
    return;
  }

  const ready = members.flatMap(member =>
    member.kind === 'image' && member.state === 'succeeded' && member.payload.output
      ? [{ member, output: member.payload.output }]
      : []
  );
  // Each image may wait out its moderation scan; waiting for the batch in parallel keeps "make N" within one wait.
  const scans = await Promise.allSettled(ready.map(({ output }) => waitUntilServeable(output, deps)));

  let posted = 0;
  // A succeeded take with no stored output cannot be posted either.
  let notPosted = readyCount - ready.length;
  for (const [index, { member, output }] of ready.entries()) {
    const delivered = await postOutput(
      {
        jobId: member.id,
        requestedBy: member.requestedBy,
        output,
        medium: 'image',
        filename: `image-${member.id}.${IMAGE_EXTENSIONS[output.contentType] ?? 'png'}`,
        ...(posted === 0 && { comment: readyCount > 1 ? 'Your images are ready.' : 'Your image is ready.' }),
        linkLabel: 'View image',
        scan: scans[index],
      },
      target,
      client,
      deps
    );
    if (delivered) posted++;
    else notPosted++;
  }

  const summary = imageBatchSummary(completion, notPosted);
  if (summary) await post(client, anchor.id, target, summary, deps, 'image');
}

/** The Slack channel of the group completion fan-out: image batches requested from a Slack thread. */
export const imageGroupSlackSubscriber = (deps: SlackJobDeliveryDeps): GroupCompletionSubscriber => ({
  name: 'slack',
  wants: job => job.kind === 'image' && job.delivery?.kind === 'slack',
  deliver: completion => deliverImageGroupToSlack(completion, deps),
});
