import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VIDEO_MODEL_CATALOG, type VideoModelId } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { CreateVideoJobInput, CreateVideoJobResult } from '../../../../videoJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildVideoToolSchema, type VideoToolArgs } from './buildSchema';

export type VideoToolConfig = {
  usableModels: readonly VideoModelId[];
  createJob: (input: CreateVideoJobInput) => Promise<CreateVideoJobResult>;
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

// ToolContext carries no tool call id, so identical calls within one turn collapse to one job by design.
const buildIdempotencyKey = (userId: string, questId: string | undefined, request: unknown): string | undefined => {
  if (!questId) return undefined;
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32);
  return `agent:${userId}:${questId}:${digest}`;
};

const toRequest = (args: VideoToolArgs) => {
  const caps = VIDEO_MODEL_CATALOG[args.model];
  return {
    model: args.model,
    mode: args.inputImageFileId ? 'image_to_video' : 'text_to_video',
    prompt: args.prompt,
    durationSeconds: args.durationSeconds ?? caps.defaults.durationSeconds,
    aspectRatio: args.aspectRatio ?? caps.defaults.aspectRatio,
    resolution: args.resolution ?? caps.defaults.resolution,
    ...(args.inputImageFileId ? { inputImageFileId: args.inputImageFileId } : {}),
  };
};

const toToolParameters = (schema: z.ZodType): ICompletionOptionTools['toolSchema']['parameters'] => {
  const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema);
  // Cast: the adapter type demands a description on every property, which optional enums lack.
  return jsonSchema as ICompletionOptionTools['toolSchema']['parameters'];
};

// Hosts that never wire a VideoToolConfig (and registry-wide builds) still construct every tool in b4mTools,
// so a missing config yields an inert tool instead of throwing and taking the whole turn down.
const buildUnavailableTool = (): ICompletionOptionTools => ({
  toolFn: async () => 'Video generation is not available in this context.',
  toolSchema: {
    name: 'video_generation',
    description: 'Video generation is not available in this context.',
    parameters: { type: 'object', properties: {} },
  },
});

// Billing lives in createVideoJob (the job engine), so this tool deliberately never uses context.onStart/onFinish.
export const videoGenerationTool: ToolDefinition = {
  name: 'video_generation',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isVideoToolConfig(config)) return buildUnavailableTool();
    const { schema, description } = buildVideoToolSchema(config.usableModels);
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        const request = toRequest(args);
        const result = await config.createJob({
          user: { id: context.userId, organizationId: context.organizationId ?? null },
          request,
          source: 'agent',
          questId: context.questId,
          idempotencyKey: buildIdempotencyKey(context.userId, context.questId, request),
        });
        if (!result.ok) return `Video generation failed (${result.code}): ${result.message}`;
        await context.statusUpdate({ videoJobIds: [result.job.id] });
        return JSON.stringify({
          jobId: result.job.id,
          estimatedSeconds: VIDEO_MODEL_CATALOG[args.model].typicalRenderSeconds,
        });
      },
      toolSchema: { name: 'video_generation', description, parameters: toToolParameters(schema) },
    };
  },
};
