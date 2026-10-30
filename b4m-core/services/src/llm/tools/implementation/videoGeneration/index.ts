import { VIDEO_MODEL_CATALOG, type VideoModelId } from '@bike4mind/common';
import type { CreateVideoJobInput, CreateVideoJobResult } from '../../../../videoJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { paidPlanRefusalOrRethrow } from '../../helpers/toolModelRefusal';
import {
  buildJobIdempotencyKey,
  buildUnavailableTool,
  isReplayOfDeadJob,
  toToolParameters,
} from '../generationJobTool';
import { buildVideoToolSchema, type VideoToolArgs } from './buildSchema';

export type VideoToolConfig = {
  usableModels: readonly VideoModelId[];
  createJob: (input: CreateVideoJobInput) => Promise<CreateVideoJobResult>;
  /** Surfaces with no progress UI use this to tell the model how the finished clip reaches the user. */
  deliveryNote?: string;
};

type PopulatedVideoToolConfig = VideoToolConfig & { usableModels: readonly [VideoModelId, ...VideoModelId[]] };

export const isVideoToolConfig = (value: unknown): value is PopulatedVideoToolConfig =>
  typeof value === 'object' &&
  value !== null &&
  'createJob' in value &&
  typeof value.createJob === 'function' &&
  'usableModels' in value &&
  Array.isArray(value.usableModels) &&
  value.usableModels.length > 0;

// Still the legacy single-image fields (read as one first_frame input), not `inputs`: a handler from before
// `inputs` existed cannot read an inputs-only payload, so a rollback would fail every pending agent job. Switch
// once that rollback window has passed, or when the tool offers more than one image.
const toRequest = (args: VideoToolArgs) => {
  const caps = VIDEO_MODEL_CATALOG[args.model];
  return {
    model: args.model,
    mode: args.inputImageFileId || args.inputGeneratedImageKey ? 'image_to_video' : 'text_to_video',
    prompt: args.prompt,
    durationSeconds: args.durationSeconds ?? caps.defaults.durationSeconds,
    aspectRatio: args.aspectRatio ?? caps.defaults.aspectRatio,
    resolution: args.resolution ?? caps.defaults.resolution,
    ...(args.inputImageFileId ? { inputImageFileId: args.inputImageFileId } : {}),
    ...(args.inputGeneratedImageKey ? { inputGeneratedImageKey: args.inputGeneratedImageKey } : {}),
  };
};

// Billing lives in createVideoJob (the job engine), so this tool deliberately never uses context.onStart/onFinish.
export const videoGenerationTool: ToolDefinition = {
  name: 'video_generation',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isVideoToolConfig(config)) return buildUnavailableTool('video_generation', 'Video generation');
    const { schema, description } = buildVideoToolSchema(config.usableModels);
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        // Checked here too (createVideoJob refuses it as well) so the model gets a message naming its own fields.
        if (args.inputImageFileId && args.inputGeneratedImageKey) {
          return 'Video generation failed (invalid_request): set inputImageFileId or inputGeneratedImageKey, not both.';
        }
        const request = toRequest(args);
        // createVideoJob asserts model admission itself; its REST callers need the throw, the model needs a result.
        let result: CreateVideoJobResult;
        try {
          result = await config.createJob({
            user: {
              id: context.userId,
              organizationId: context.organizationId ?? null,
              adminRoleWithheld: !context.user.isAdmin,
            },
            request,
            source: 'agent',
            apiKeyId: context.apiKeyId,
            questId: context.questId,
            idempotencyKey: buildJobIdempotencyKey(context.userId, context.questId, request),
          });
        } catch (error) {
          return paidPlanRefusalOrRethrow(context, error, request.model, 'video_generation');
        }
        if (!result.ok) return `Video generation failed (${result.code}): ${result.message}`;
        if (isReplayOfDeadJob(result.created, result.job.state)) {
          const reason = result.job.error?.code ?? result.job.state;
          return `Video generation failed (${reason}): an identical request already ended without a video.`;
        }
        await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'video' }] });
        return JSON.stringify({
          jobId: result.job.id,
          estimatedSeconds: VIDEO_MODEL_CATALOG[args.model].typicalRenderSeconds,
          ...(config.deliveryNote && { note: config.deliveryNote }),
        });
      },
      toolSchema: { name: 'video_generation', description, parameters: toToolParameters(schema) },
    };
  },
};
