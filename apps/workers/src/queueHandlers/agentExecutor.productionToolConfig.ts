/**
 * The config behind the four `production_*` director tools for agent-mode runs.
 *
 * It reuses the run's capped image, video and music configs (agentExecutor.imageToolConfig.ts and friends), so
 * every take, clip and song is an ordinary generation job that holds and settles its own credits under the
 * per-run caps. Voiceover and sound effects are speech and sound_effect jobs under the run's audio caps.
 */
import {
  IMAGE_MODEL_CATALOG,
  referenceImageState,
  type AudioGenerationToolCall,
  type GenerateImageToolCall,
  type GenerationJobState,
  type IUserDocument,
  type ImageModels,
} from '@bike4mind/common';
import {
  fabFileRepository,
  generationJobRepository,
  projectRepository,
  studioCompositionRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { studioCompositionService } from '@bike4mind/services';
import type {
  AudioToolJobs,
  ImageToolConfig,
  MusicToolConfig,
  ProductionJobView,
  ProductionToolConfig,
  VideoToolConfig,
} from '@bike4mind/services/llm/tools';
import { getImageJobDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import { listUsableImageModels } from '@bike4mind/server-utils/imageGenerations/listUsableImageModels';
import { isStudioFeatureEnabled } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import type { Request } from 'express';

type ProductionJobRecord = {
  id: string;
  requestedBy: string;
  state: GenerationJobState;
  /** Kind-specific; the stored output (ImageJobOutput, VideoJobOutput, MusicJobOutput) sits at `payload.output`. */
  payload?: { output?: { fileId?: string; durationSeconds?: number } };
  error?: { code?: string; message: string };
};

export type AgentProductionToolConfigDeps = {
  /** Whether the Productions flag and its audience rule open the tools to the run's user. */
  isEnabled(user: IUserDocument): Promise<boolean>;
  compositionAdapters: studioCompositionService.StudioCompositionServiceAdapters;
  findJob(id: string): Promise<ProductionJobRecord | null>;
  /** Catalog image models that take a reference image in generate mode and the user can run, best first. */
  listReferenceImageModels(userId: string): Promise<string[]>;
  logger: Logger;
};

export type BuildAgentProductionToolConfigInput = {
  /** The run's user, with the admin role already withheld when the run must not act as an admin. */
  user: IUserDocument;
  /** Set when an API key started the run; such runs never get the tools. */
  apiKeyId?: string;
  questId?: string;
  /** Whether the run's toolbelt names any production tool; skips every read otherwise. */
  toolEnabled: boolean;
  image: ImageToolConfig | null;
  video: VideoToolConfig | null;
  music: MusicToolConfig | null;
  imageSelection?: Partial<GenerateImageToolCall>;
  audioSettings?: Partial<AudioGenerationToolCall>;
  /** The run's capped speech and sound-effect job functions (agentExecutor.audioToolConfig.ts). */
  audioJobs?: AudioToolJobs;
};

const toJobView = (job: ProductionJobRecord): ProductionJobView => ({
  id: job.id,
  state: job.state,
  ...(job.payload?.output?.fileId && { fileId: job.payload.output.fileId }),
  ...(job.payload?.output?.durationSeconds !== undefined && { durationSeconds: job.payload.output.durationSeconds }),
  ...(job.error && { error: { code: job.error.code ?? 'job_failed', message: job.error.message } }),
});

const takesReference = (model: string): boolean =>
  model in IMAGE_MODEL_CATALOG &&
  (IMAGE_MODEL_CATALOG[model as ImageModels].modes.generate?.inputs.reference?.max ?? 0) > 0;

/** The user's own pick first when it can take the product photo, then the usable reference models. */
const orderImageModels = (selected: string | undefined, usable: readonly string[]): string[] =>
  selected && takesReference(selected) ? [selected, ...usable.filter(model => model !== selected)] : [...usable];

const warnNotOffered = (logger: Logger, error: unknown): void =>
  logger.warn('[AgentProduction] could not build the production tool config; tools not offered', {
    error: error instanceof Error ? error.message : String(error),
  });

/**
 * Whether the run can be offered the production tools: named in the toolbelt, not an API-key run, a Quest to attach
 * job cards to, and the Productions flag open to the user. Checked before the media configs are built, so a closed
 * flag skips their reads. Fails closed.
 */
export async function productionToolsOpen(
  input: Pick<BuildAgentProductionToolConfigInput, 'user' | 'apiKeyId' | 'questId' | 'toolEnabled'>,
  deps: Pick<AgentProductionToolConfigDeps, 'isEnabled' | 'logger'>
): Promise<boolean> {
  if (!input.toolEnabled || input.apiKeyId || !input.questId) return false;
  try {
    return await deps.isEnabled(input.user);
  } catch (error) {
    warnNotOffered(deps.logger, error);
    return false;
  }
}

/**
 * Null means the tools are not offered: productionToolsOpen says no, or there is no image config (takes are the
 * one step nothing replaces). A failure while building fails closed.
 */
export async function buildAgentProductionToolConfig(
  input: BuildAgentProductionToolConfigInput,
  deps: AgentProductionToolConfigDeps
): Promise<ProductionToolConfig | null> {
  const { user, image } = input;
  if (!image || !(await productionToolsOpen(input, deps))) return null;
  try {
    const imageModels = orderImageModels(input.imageSelection?.model, await deps.listReferenceImageModels(user.id));
    const adapters = deps.compositionAdapters;
    return {
      compositions: {
        get: id => studioCompositionService.getComposition(user.id, adapters, id),
        update: (id, patch) => studioCompositionService.updateComposition(user.id, adapters, id, patch),
      },
      image,
      imageModels,
      video: input.video,
      music: input.music,
      audio: input.audioJobs ? { ...input.audioSettings, jobs: input.audioJobs } : null,
      runId: input.questId,
      findJobs: async ids => {
        const jobs = await Promise.all(ids.map(id => deps.findJob(id)));
        return jobs.filter((job): job is ProductionJobRecord => job?.requestedBy === user.id).map(toJobView);
      },
      referenceImages: async ids => {
        if (ids.length === 0) return new Map();
        const files = await adapters.db.fabFiles.findAccessibleInIds([...ids], { userId: user.id });
        return new Map(
          files.flatMap(file => {
            const state = referenceImageState(file, user.id);
            return state ? [[file.id, state] as const] : [];
          })
        );
      },
    };
  } catch (error) {
    warnNotOffered(deps.logger, error);
    return null;
  }
}

export function getAgentProductionToolConfigDeps(logger: Logger): AgentProductionToolConfigDeps {
  // productionToolsOpen runs once before the media configs and again inside the builder; one read serves both.
  const flagReads = new WeakMap<IUserDocument, Promise<boolean>>();
  return {
    // The flag check reads only req.user (and memoizes the plan on the object), so a request holding the run's user is
    // enough; there is no HTTP request in a queue handler.
    isEnabled: user => {
      const read = flagReads.get(user) ?? isStudioFeatureEnabled('productions', { user } as unknown as Request);
      flagReads.set(user, read);
      return read;
    },
    compositionAdapters: {
      db: { compositions: studioCompositionRepository, fabFiles: fabFileRepository, projects: projectRepository },
    },
    findJob: async id => (await generationJobRepository.findById(id)) as ProductionJobRecord | null,
    listReferenceImageModels: async userId => {
      const offered = Object.keys(IMAGE_MODEL_CATALOG)
        .filter(takesReference)
        .map(id => ({ id, name: id }));
      const usable = await listUsableImageModels(userId, offered, getImageJobDeps());
      return usable.map(model => model.id);
    },
    logger,
  };
}
