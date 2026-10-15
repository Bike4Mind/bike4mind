import { MUSIC_MODEL_CATALOG, type MusicGenerationRequest, type MusicModelId } from '@bike4mind/common';
import type { CreateMusicJobInput, CreateMusicJobResult } from '../../../../musicJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import {
  buildJobIdempotencyKey,
  buildUnavailableTool,
  isReplayOfDeadJob,
  toToolParameters,
} from '../generationJobTool';
import { buildMusicToolSchema, type MusicToolArgs } from './buildSchema';

export type MusicToolConfig = {
  usableModels: readonly MusicModelId[];
  createJob: (input: CreateMusicJobInput) => Promise<CreateMusicJobResult>;
};

type PopulatedMusicToolConfig = MusicToolConfig & { usableModels: readonly [MusicModelId, ...MusicModelId[]] };

export const isMusicToolConfig = (value: unknown): value is PopulatedMusicToolConfig =>
  typeof value === 'object' &&
  value !== null &&
  'createJob' in value &&
  typeof value.createJob === 'function' &&
  'usableModels' in value &&
  Array.isArray(value.usableModels) &&
  value.usableModels.length > 0;

// Defaults (length, instrumental) are left to createMusicJob, which resolves them per model.
const toRequest = (args: MusicToolArgs): MusicGenerationRequest => ({
  model: args.model,
  prompt: args.prompt,
  ...('lyrics' in args && typeof args.lyrics === 'string' && { lyrics: args.lyrics }),
  ...(args.instrumental !== undefined && { instrumental: args.instrumental }),
  ...(args.durationSeconds !== undefined && { durationSeconds: args.durationSeconds }),
});

// Billing lives in createMusicJob (the job engine), so this tool deliberately never uses context.onStart/onFinish.
export const musicGenerationTool: ToolDefinition = {
  name: 'music_generation',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isMusicToolConfig(config)) return buildUnavailableTool('music_generation', 'Music generation');
    const { schema, description } = buildMusicToolSchema(config.usableModels);
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        const request = toRequest(args);
        const result = await config.createJob({
          user: { id: context.userId, organizationId: context.organizationId ?? null },
          request,
          source: 'agent',
          sessionId: context.sessionId,
          questId: context.questId,
          idempotencyKey: buildJobIdempotencyKey(context.userId, context.questId, request),
        });
        if (!result.ok) return `Music generation failed (${result.code}): ${result.message}`;
        if (isReplayOfDeadJob(result.created, result.job.state)) {
          const reason = result.job.error?.code ?? result.job.state;
          return `Music generation failed (${reason}): an identical request already ended without a song.`;
        }
        await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'music' }] });
        return JSON.stringify({
          jobId: result.job.id,
          estimatedSeconds: MUSIC_MODEL_CATALOG[args.model].typicalRenderSeconds,
        });
      },
      toolSchema: { name: 'music_generation', description, parameters: toToolParameters(schema) },
    };
  },
};
