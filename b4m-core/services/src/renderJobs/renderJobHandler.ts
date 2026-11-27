import { usdToCreditsStochastic, type GeneratedAssetLineageEntry, type VideoJobOutput } from '@bike4mind/common';
import { releaseJobHold, settleJobHold } from '../generationJobs/settlement';
import { storeGeneratedOutput } from '../generationJobs/storeOutput';
import type { GenerationJobHandler, StepResult } from '../generationJobs/types';
import type { RenderJob, RenderJobDeps } from './types';
import { RENDER_FEATURE_LABEL } from './createRenderJobs';

type RenderStepResult = StepResult<'render'>;

/**
 * The store step buffers the encode in the generation-job Lambda (2 GB), so a larger file fails cleanly instead of
 * exhausting it. Well above a 30-minute 1080p export at the worker's bitrate.
 */
export const MAX_RENDER_OUTPUT_BYTES = 600 * 1024 * 1024;

// Stamped on the ledger row and the file's generation metadata; the render has no third-party model.
export const RENDER_MODEL_ID = 'studio-render';

const fail = (message: string, code: 'provider_error' | 'output_too_large' = 'provider_error'): RenderStepResult => ({
  next: 'failed',
  error: { code, message },
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every media clip the render composited, once each, capped like any lineage by saveGeneratedAsset. */
const lineageOf = (job: RenderJob): GeneratedAssetLineageEntry[] => {
  const fileIds = job.payload.request.timeline.tracks.flatMap(track =>
    track.kind === 'captions' || !track.enabled ? [] : track.clips.map(clip => clip.fileId)
  );
  return [...new Set(fileIds)].map(fileId => ({ fileId, role: 'timeline_clip' as const }));
};

const fileTitle = (job: RenderJob): string => {
  const { title, output } = job.payload.request;
  return `${title} (${output.aspectRatio}, ${output.width}x${output.height})`;
};

/**
 * The render kind on the generic GenerationJobEngine. The encode runs on the render worker, outside the engine's
 * 5-minute step: submit queues it, poll reads the worker's status object, store saves the MP4 to Files with its
 * clips as lineage. Credits held at create are settled on success and returned on any other end.
 */
export function createRenderJobHandler(deps: RenderJobDeps): GenerationJobHandler<'render'> {
  const settle = async (job: RenderJob) => {
    const { usd } = job.payload.pricing;
    const credits = Number.isFinite(usd) ? usdToCreditsStochastic(usd) : Number.NaN;
    // video_generation_usage is quest-scoped; a render has no quest, so the job id stands in, as for API video jobs.
    await settleJobHold(
      job,
      {
        credits,
        entry: { type: 'video_generation_usage', sessionId: job.id, questId: job.id, model: RENDER_MODEL_ID },
        featureLabel: RENDER_FEATURE_LABEL,
      },
      deps
    );
  };

  return {
    kind: 'render',
    submitMode: 'async',

    async submit(job) {
      try {
        await deps.dispatchRender(job.id);
      } catch (error) {
        // A failed send queued nothing; a send that landed despite the error is harmless, the worker is idempotent.
        deps.logger.warn('render job dispatch failed; retrying', { jobId: job.id, message: messageOf(error) });
        return { next: 'retry', reason: messageOf(error) };
      }
      return { next: 'running', payload: job.payload };
    },

    async poll(job) {
      const status = await deps.readRenderStatus(job.id);
      if (!status) return { next: 'poll_again', progress: 0 };
      switch (status.state) {
        case 'running':
          return { next: 'poll_again', progress: status.progress };
        case 'failed':
          return fail(status.message);
        case 'succeeded':
          if (status.bytes > MAX_RENDER_OUTPUT_BYTES) {
            return fail('The rendered video is larger than an export can store', 'output_too_large');
          }
          return {
            next: 'storing',
            payload: {
              ...job.payload,
              rendered: { s3Key: status.s3Key, bytes: status.bytes, durationSeconds: status.durationSeconds },
            },
          };
      }
    },

    async store(job, context) {
      const { rendered, request } = job.payload;
      if (!rendered) return fail('storing without a rendered output');
      const bytes = await deps.fetchRenderedOutput(rendered.s3Key, context.signal);
      const contentType = 'video/mp4';
      // The output is only persisted by the terminal commit, so a crash here re-runs the save: saveToFiles dedups
      // per job id.
      const { location } = await storeGeneratedOutput(
        {
          job,
          noun: 'render',
          bytes,
          contentType,
          generation: {
            generator: 'video',
            provider: RENDER_MODEL_ID,
            modelId: RENDER_MODEL_ID,
            jobId: job.id,
            prompt: fileTitle(job),
            durationSeconds: rendered.durationSeconds,
            // The timeline itself stays on the job: it can be far larger than the stored request cap.
            request: { compositionId: request.compositionId, output: request.output },
          },
          derivedFrom: lineageOf(job),
          bucketFolder: 'studio-render',
          extension: 'mp4',
          onFilesError: 'rethrow',
          signal: context.signal,
        },
        deps
      );
      const output: VideoJobOutput = {
        ...location,
        contentType,
        bytes: bytes.byteLength,
        durationSeconds: rendered.durationSeconds,
      };
      return { next: 'succeeded', payload: { ...job.payload, output } };
    },

    // A queued encode cannot be recalled from SQS; the worker skips any job that is no longer running.
    async cancelAtProvider() {},

    async onTerminal(job) {
      if (job.state === 'succeeded') await settle(job);
      else await releaseJobHold(job, deps);
    },
  };
}
