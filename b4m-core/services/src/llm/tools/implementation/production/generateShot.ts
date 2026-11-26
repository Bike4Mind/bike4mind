import { z } from 'zod';
import {
  STUDIO_COMPOSITION_LIMITS,
  StudioFileIdSchema,
  VIDEO_MODEL_CATALOG,
  productImageReferenceFileIds,
  productReferenceFileIds,
  shotCharacters,
  type StudioShot,
} from '@bike4mind/common';
import { IMAGE_JOB_BATCH_MAX } from '../../../../imageJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildUnavailableTool, toToolParameters } from '../generationJobTool';
import { isProductionToolConfig, type ProductionJobView, type ProductionToolConfig } from './config';
import {
  buildShotImagePrompt,
  jobOutcome,
  pickVideoModel,
  submitShotClip,
  submitShotImages,
  videoDurationFor,
  waitForJobs,
} from './jobs';
import { DEFAULT_SHOT_DURATION_MS } from './layout';
import { ensureProductLook, type ProductLook } from './productLook';
import {
  CompositionIdArg,
  ProductionToolError,
  describeProductionError,
  primaryAspectRatio,
  updateShots,
} from './shared';

type Context = Omit<ToolContext, 'config'>;

const schema = z.object({
  compositionId: CompositionIdArg,
  shotIds: z.array(z.string().min(1)).optional().describe('The shots to work on; omit for every shot.'),
  takesPerShot: z
    .number()
    .int()
    .min(1)
    .max(IMAGE_JOB_BATCH_MAX)
    .optional()
    .describe('Key-frame takes to make for a shot that has no chosen take yet. Default 1.'),
  animate: z
    .boolean()
    .optional()
    .describe(
      'Animate each chosen take into a video clip. Default true; false keeps the stills. A shot with no prompt ' +
        '(made in the editor) is animated only when named in shotIds.'
    ),
  chosenTakes: z
    .array(z.object({ shotId: z.string().min(1), fileId: StudioFileIdSchema }))
    .optional()
    .describe("Pick a different take for a shot (one of that shot's files); its old clip is dropped."),
});
type GenerateShotArgs = z.infer<typeof schema>;

const description =
  'Make the takes and clips for the shots of a Studio production. For each shot without a chosen take it starts ' +
  "image jobs from the shot prompt with the product images, then the shot's saved characters, as references (with " +
  'no product image, it first makes one product ' +
  'look from the brief and saves it to the brand kit), picks the first finished take, then ' +
  'animates it into a video clip. Waits for the jobs; if some are still running when it returns, call it again with ' +
  'the same arguments to keep waiting (nothing is started twice). Then call production_add_audio.';

const STILL_KEPT = 'kept as a still: it has no prompt; name it in shotIds to animate it.';

type ShotReport = {
  id: string;
  chosenFileId?: string;
  clipFileId?: string;
  pending?: string[];
  problem?: string;
  /** Characters the shot features left out of the references: image over the model's cap, or not usable as one. */
  charactersDropped?: { names: string[]; model?: string };
};

const patchShot = (shots: StudioShot[], id: string, patch: (shot: StudioShot) => StudioShot): StudioShot[] =>
  shots.map(shot => (shot.id === id ? patch(shot) : shot));

/** Adds a file, evicting the oldest one that is neither the pick nor the clip once the shot is full. */
function withFile(shot: Pick<StudioShot, 'fileIds' | 'chosenFileId' | 'clipFileId'>, fileId: string): string[] {
  if (shot.fileIds.includes(fileId)) return [...shot.fileIds];
  const files = [...shot.fileIds, fileId];
  if (files.length <= STUDIO_COMPOSITION_LIMITS.shotFilesMax) return files;
  const evict = files.findIndex(id => id !== shot.chosenFileId && id !== shot.clipFileId && id !== fileId);
  return files.filter((_, index) => index !== evict);
}

function selectShots(shots: readonly StudioShot[], shotIds: readonly string[] | undefined): StudioShot[] {
  if (!shotIds) return [...shots];
  const unknown = shotIds.filter(id => !shots.some(shot => shot.id === id));
  if (unknown.length > 0) throw new ProductionToolError(`no shot with id ${unknown.join(', ')}.`);
  return shots.filter(shot => shotIds.includes(shot.id));
}

function applyChosenTakes(shots: StudioShot[], chosen: GenerateShotArgs['chosenTakes']): StudioShot[] {
  return (chosen ?? []).reduce((current, { shotId, fileId }) => {
    const shot = current.find(candidate => candidate.id === shotId);
    if (!shot) throw new ProductionToolError(`no shot with id ${shotId}.`);
    const take = fileId.toLowerCase();
    if (!shot.fileIds.includes(take)) throw new ProductionToolError(`${take} is not one of shot ${shotId}'s files.`);
    return patchShot(current, shotId, ({ clipFileId: _oldClip, ...rest }) => ({ ...rest, chosenFileId: take }));
  }, shots);
}

const succeededFiles = (jobIds: readonly string[], jobs: Map<string, ProductionJobView>): string[] =>
  jobIds.flatMap(id => {
    const job = jobs.get(id);
    return job?.state === 'succeeded' && job.fileId ? [job.fileId] : [];
  });

const unfinished = (jobIds: readonly string[], jobs: Map<string, ProductionJobView>): string[] =>
  jobIds.filter(id => jobOutcome(jobs.get(id)).startsWith('still'));

const failures = (jobIds: readonly string[], jobs: Map<string, ProductionJobView>): string =>
  jobIds
    .map(id => jobOutcome(jobs.get(id)))
    .filter(outcome => !outcome.startsWith('still') && outcome !== 'succeeded')
    .join('; ');

/**
 * Starts takes for every shot that needs one, waits, and records the finished takes and the pick. With no product
 * image to reference, it first makes the production's product look (productLook.ts) and references that.
 */
async function makeTakes(
  context: Context,
  config: ProductionToolConfig,
  compositionId: string,
  shots: readonly StudioShot[],
  takes: number,
  reports: Map<string, ShotReport>
): Promise<{ shots: StudioShot[]; productLook?: ProductLook['status'] }> {
  const needing = shots.filter(candidate => !candidate.chosenFileId);
  for (const shot of needing.filter(candidate => !candidate.prompt)) {
    reports.set(shot.id, { id: shot.id, problem: 'no prompt; storyboard it first' });
  }
  const toShoot = needing.filter(candidate => candidate.prompt);
  if (toShoot.length === 0) return { shots: [...shots] };

  const composition = await config.compositions.get(compositionId);
  const characterFileIds = composition.brandKit.characters.map(character => character.fileId);
  const states = await config.referenceImages([...productReferenceFileIds(composition), ...characterFileIds]);
  let references = productImageReferenceFileIds(composition, states);
  let referencesChecking = references.some(id => states.get(id) === 'checking');
  let look: ProductLook | undefined;
  if (references.length === 0) {
    look = await ensureProductLook(context, config, composition);
    references = look.references;
    referencesChecking = look.checking === true;
    if (look.pendingJobId) {
      for (const shot of toShoot)
        reports.set(shot.id, { id: shot.id, pending: [`product look: ${look.pendingJobId}`] });
      return { shots: [...shots], productLook: look.status };
    }
  }
  const aspectRatio = primaryAspectRatio(composition);
  const started = new Map<string, string[]>();
  const dropped = new Map<string, NonNullable<ShotReport['charactersDropped']>>();
  for (const shot of toShoot) {
    const prompt = buildShotImagePrompt(shot.prompt as string, composition.brandKit.colors, references.length > 0);
    const featured = shotCharacters(shot, composition.brandKit.characters);
    const characters = featured.filter(character => states.has(character.fileId));
    const unusable = featured.filter(character => !states.has(character.fileId)).map(character => character.name);
    if (unusable.length > 0) dropped.set(shot.id, { names: unusable });
    const submitted = await submitShotImages(
      context,
      config,
      {
        prompt,
        references,
        characters,
        referencesChecking: referencesChecking || characters.some(c => states.get(c.fileId) === 'checking'),
        aspectRatio,
        compositionId,
        shotId: shot.id,
      },
      takes
    );
    if (submitted.ok && submitted.charactersDropped) {
      dropped.set(shot.id, {
        names: [...(dropped.get(shot.id)?.names ?? []), ...submitted.charactersDropped],
        model: submitted.model,
      });
    }
    if (submitted.ok) started.set(shot.id, submitted.jobIds);
    else if (submitted.notReady) reports.set(shot.id, { id: shot.id, pending: [`takes: ${submitted.message}`] });
    else reports.set(shot.id, { id: shot.id, problem: submitted.message });
  }
  if (started.size === 0) return { shots: [...shots], productLook: look?.status };

  const jobs = await waitForJobs(config, [...started.values()].flat(), context.getAbortSignal?.());
  const updated = await updateShots(config, compositionId, current =>
    [...started].reduce((acc, [shotId, jobIds]) => {
      const files = succeededFiles(jobIds, jobs);
      return patchShot(acc, shotId, shot => ({
        ...shot,
        fileIds: files.reduce((fileIds, file) => withFile({ ...shot, fileIds }, file), shot.fileIds),
        ...(!shot.chosenFileId && files[0] && { chosenFileId: files[0] }),
      }));
    }, current)
  );
  for (const [shotId, jobIds] of started) {
    const pending = unfinished(jobIds, jobs);
    const failed = succeededFiles(jobIds, jobs).length === 0 ? failures(jobIds, jobs) : '';
    const charactersDropped = dropped.get(shotId);
    reports.set(shotId, {
      id: shotId,
      ...(pending.length > 0 && { pending }),
      ...(failed && { problem: `takes failed: ${failed}` }),
      ...(charactersDropped && { charactersDropped }),
    });
  }
  return {
    shots: updated.shots.filter(shot => shots.some(selected => selected.id === shot.id)),
    productLook: look?.status,
  };
}

/** Animates every chosen take that has no clip yet, waits, and records the clips. */
async function makeClips(
  context: Context,
  config: ProductionToolConfig,
  compositionId: string,
  shots: readonly StudioShot[],
  reports: Map<string, ShotReport>
): Promise<string | undefined> {
  const model = config.video && pickVideoModel(config.video.usableModels);
  if (!model) return 'Video is not available, so the chosen stills stand in for clips.';
  const composition = await config.compositions.get(compositionId);
  const aspectRatio = primaryAspectRatio(composition);
  const started = new Map<string, string>();
  for (const shot of shots.filter(candidate => candidate.chosenFileId && !candidate.clipFileId)) {
    const shotMs = shot.durationMs ?? DEFAULT_SHOT_DURATION_MS;
    const submitted = await submitShotClip(context, config, {
      model,
      prompt: `${shot.prompt ?? shot.title}. Subtle, smooth camera motion; keep the product exactly as it is.`,
      stillFileId: shot.chosenFileId as string,
      durationSeconds: videoDurationFor(VIDEO_MODEL_CATALOG[model], shotMs),
      aspectRatio,
    });
    const report = { ...reports.get(shot.id), id: shot.id };
    if (submitted.ok) started.set(shot.id, submitted.jobIds[0] as string);
    else if (submitted.notReady)
      reports.set(shot.id, { ...report, pending: [...(report.pending ?? []), `clip: ${submitted.message}`] });
    else reports.set(shot.id, { ...report, problem: `clip not started: ${submitted.message}` });
  }
  if (started.size === 0) return undefined;

  const jobs = await waitForJobs(config, [...started.values()], context.getAbortSignal?.());
  await updateShots(config, compositionId, current =>
    [...started].reduce((acc, [shotId, jobId]) => {
      const job = jobs.get(jobId);
      if (job?.state !== 'succeeded' || !job.fileId) return acc;
      const clipFileId = job.fileId;
      // A zero or missing length is unknown, not empty: the shot keeps its own length.
      const clipMs = job.durationSeconds ? Math.round(job.durationSeconds * 1000) : Infinity;
      return patchShot(acc, shotId, shot => ({
        ...shot,
        fileIds: withFile(shot, clipFileId),
        clipFileId,
        // A clip shorter than its shot would leave the shot playing past the end of its source.
        durationMs: Math.min(shot.durationMs ?? DEFAULT_SHOT_DURATION_MS, clipMs),
      }));
    }, current)
  );
  for (const [shotId, jobId] of started) {
    const outcome = jobOutcome(jobs.get(jobId));
    if (outcome === 'succeeded') continue;
    const report = reports.get(shotId) ?? { id: shotId };
    reports.set(
      shotId,
      outcome.startsWith('still')
        ? { ...report, pending: [...(report.pending ?? []), jobId] }
        : { ...report, problem: `clip ${outcome}` }
    );
  }
  return undefined;
}

export const productionGenerateShotTool: ToolDefinition = {
  name: 'production_generate_shot',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isProductionToolConfig(config)) return buildUnavailableTool('production_generate_shot', 'Studio Productions');
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        const reports = new Map<string, ShotReport>();
        try {
          const composition = await config.compositions.get(args.compositionId);
          const selected = selectShots(composition.shots, args.shotIds);
          if (selected.length === 0) throw new ProductionToolError('the production has no shots; storyboard it first.');
          let shots = selected;
          if (args.chosenTakes?.length) {
            const updated = await config.compositions.update(args.compositionId, {
              shots: applyChosenTakes(composition.shots, args.chosenTakes),
            });
            shots = updated.shots.filter(shot => selected.some(candidate => candidate.id === shot.id));
          }
          const taken = await makeTakes(context, config, args.compositionId, shots, args.takesPerShot ?? 1, reports);
          shots = taken.shots;
          // A prompt-less shot is an editor-made still; animate it only when the director names it.
          const toAnimate = shots.filter(shot => shot.prompt || args.shotIds?.includes(shot.id));
          if (args.animate !== false) {
            for (const shot of shots.filter(
              candidate => candidate.chosenFileId && !toAnimate.includes(candidate) && !candidate.clipFileId
            )) {
              reports.set(shot.id, { ...reports.get(shot.id), id: shot.id, problem: STILL_KEPT });
            }
          }
          const videoNote =
            args.animate === false
              ? undefined
              : await makeClips(context, config, args.compositionId, toAnimate, reports);

          const final = await config.compositions.get(args.compositionId);
          const summary = final.shots
            .filter(shot => selected.some(candidate => candidate.id === shot.id))
            .map(shot => ({
              ...reports.get(shot.id),
              id: shot.id,
              takes: shot.fileIds.length,
              ...(shot.chosenFileId && { chosenFileId: shot.chosenFileId }),
              ...(shot.clipFileId && { clipFileId: shot.clipFileId }),
            }));
          const stillRunning = summary.some(shot => shot.pending && shot.pending.length > 0);
          const anyDropped = summary.some(shot => shot.charactersDropped);
          return JSON.stringify({
            shots: summary,
            ...(taken.productLook && { productLook: taken.productLook }),
            ...(videoNote && { note: videoNote }),
            next: stillRunning
              ? 'Some jobs are still running: call production_generate_shot again with the same arguments to wait for them.'
              : 'Call production_add_audio, then production_assemble.',
            ...(anyDropped && {
              charactersNote:
                'Some shots name charactersDropped: the image model has too few reference slots, or the character image ' +
                'cannot be used as a reference (format or ownership), so they were drawn from the prompt alone. ' +
                'Tell the user which shots.',
            }),
          });
        } catch (error) {
          return describeProductionError(error, context.logger, 'production_generate_shot');
        }
      },
      toolSchema: { name: 'production_generate_shot', description, parameters: toToolParameters(schema) },
    };
  },
};
