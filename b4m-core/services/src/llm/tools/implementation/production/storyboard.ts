import { z } from 'zod';
import {
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_TIMELINE_LIMITS,
  StudioFileIdSchema,
  type StudioShot,
} from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildUnavailableTool, toToolParameters } from '../generationJobTool';
import { isProductionToolConfig } from './config';
import {
  DEFAULT_SHOT_DURATION_MS,
  DIRECTOR_TRACK_IDS,
  keptMusic,
  shotsTooShortForVoice,
  withDirectorTracks,
} from './layout';
import { CompositionIdArg, ProductionToolError, describeProductionError } from './shared';

export const STORYBOARD_MAX_SHOTS = 12;
const limits = STUDIO_COMPOSITION_LIMITS;

const ShotArg = z.object({
  keep: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'A current shot id (e.g. "shot-3", not its title) to carry over with its prompt, takes and clip; omit ' +
        'prompt. Use it for every shot you are not re-imagining, in any order: listing kept shots in a new order ' +
        'moves them. Other fields default to the current ones; voiceLine "" removes it.'
    ),
  title: z.string().trim().min(1).max(limits.shotTitleMaxLength).optional().describe('A short name, e.g. "Hook".'),
  intent: z
    .string()
    .trim()
    .max(limits.shotIntentMaxLength)
    .optional()
    .describe('What the shot is for, e.g. "product reveal".'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(limits.shotPromptMaxLength)
    .optional()
    .describe(
      'Image prompt for a new shot: subject, setting, light, camera, and the product. A new prompt makes new takes.'
    ),
  durationSeconds: z.number().min(1).max(30).optional().describe('Length in the cut.'),
  voiceLine: z
    .string()
    .trim()
    .max(limits.shotVoiceLineMaxLength)
    .optional()
    .describe('Voiceover line and caption for the shot, about 2 words per second of shot; a longer line is cut.'),
});

const schema = z.object({
  compositionId: CompositionIdArg,
  brief: z
    .string()
    .trim()
    .min(1)
    .max(limits.briefSummaryMaxLength)
    .optional()
    .describe("The one-line brief to save on the production, when the user gave one that isn't saved yet."),
  productFileId: StudioFileIdSchema.optional().describe(
    'The product photo (a Files id) to keep in every shot; saved to the brand kit.'
  ),
  shots: z.array(ShotArg).min(1).max(STORYBOARD_MAX_SHOTS),
  replace: z
    .boolean()
    .optional()
    .describe(
      'Only when the user asked for new pictures: lets a shot with takes get a new prompt or be removed, and cuts ' +
        'voice lines a re-time leaves without room. Never lengthens a shot past its clip.'
    ),
});
type StoryboardArgs = z.infer<typeof schema>;

const description =
  'Write the storyboard of a Studio production: every shot in order with its image prompt, length and voice line. ' +
  'Carry over each current shot you are not re-imagining with keep. About 4 shots for a 15 second ad (hook, ' +
  'product, benefit, call to action). Then call production_generate_shot.';

type ResolvedShot = { title: string; intent?: string; prompt?: string; durationMs: number; voiceLine?: string };

/**
 * A shot argument filled in from the current shot it keeps. The director often no longer has a shot's prompt in hand
 * on a follow-up turn, so keep is how it carries a shot over; a prompt with no spaces is a stand-in for one, not a
 * description of a frame, and is refused rather than turned into new takes.
 */
function resolveShot(
  shot: StoryboardArgs['shots'][number],
  current: readonly StudioShot[]
): { shot: ResolvedShot; source?: StudioShot } {
  const source = shot.keep ? current.find(candidate => candidate.id === shot.keep) : undefined;
  if (shot.keep && !source) {
    throw new ProductionToolError(
      `there is no current shot with id ${shot.keep} to keep (keep takes an id, not a title); the current shots are ${
        current.map(candidate => candidate.id).join(', ') || 'none'
      }.`
    );
  }
  if (source && shot.prompt) {
    throw new ProductionToolError(
      `${source.id} has keep and a prompt; pass keep to carry it over as it is, or a prompt without keep to re-imagine it.`
    );
  }
  const prompt = source ? source.prompt : shot.prompt;
  const title = shot.title ?? source?.title;
  const durationMs =
    shot.durationSeconds !== undefined
      ? Math.round(shot.durationSeconds * 1000)
      : source
        ? (source.durationMs ?? DEFAULT_SHOT_DURATION_MS)
        : undefined;
  if (!title || durationMs === undefined || (!source && !prompt)) {
    throw new ProductionToolError(
      'a new shot needs a title, a prompt and durationSeconds; to carry a shot over, pass keep.'
    );
  }
  if (!source && prompt && !/\s/.test(prompt)) {
    throw new ProductionToolError(
      `"${prompt}" is not an image prompt. To keep a current shot, pass keep with its id instead of a prompt.`
    );
  }
  const voiceLine = shot.voiceLine ?? source?.voiceLine;
  const intent = shot.intent ?? source?.intent;
  return {
    shot: { title, ...(intent && { intent }), ...(prompt && { prompt }), durationMs, ...(voiceLine && { voiceLine }) },
    source,
  };
}

const toShot = (shot: ResolvedShot, index: number): StudioShot => ({
  id: `shot-${index + 1}`,
  ...shot,
  fileIds: [],
});

const normalizedPrompt = (prompt: string | undefined): string =>
  (prompt ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A shot whose image prompt is unchanged keeps its takes, so a re-run that only retimes shots or rewrites their
 * voice lines costs nothing. Its clip stays only while the shot is no longer than before: generate_shot already
 * cut the shot to its clip's length, so a longer shot would play past the clip's end.
 */
function keepTakes(
  shot: StudioShot,
  previous: StudioShot | undefined,
  isSource = false
): { shot: StudioShot; clipDropped: boolean } {
  if (
    !previous ||
    previous.fileIds.length === 0 ||
    (!isSource && normalizedPrompt(previous.prompt) !== normalizedPrompt(shot.prompt))
  ) {
    return { shot, clipDropped: false };
  }
  const keepClip = previous.clipFileId !== undefined && (shot.durationMs ?? 0) <= (previous.durationMs ?? 0);
  return {
    shot: {
      ...shot,
      fileIds: previous.fileIds,
      ...(previous.chosenFileId && { chosenFileId: previous.chosenFileId }),
      ...(keepClip && { clipFileId: previous.clipFileId }),
    },
    clipDropped: previous.clipFileId !== undefined && !keepClip,
  };
}

/**
 * The current shot a new one carries its takes from: the one at the same place when its prompt matches, otherwise
 * the first with the same prompt, so inserting or moving a shot keeps the takes of the shots around it.
 */
function previousShot(
  current: readonly StudioShot[],
  prompt: string | undefined,
  index: number
): StudioShot | undefined {
  const wanted = normalizedPrompt(prompt);
  const atIndex = current[index];
  if (atIndex && normalizedPrompt(atIndex.prompt) === wanted) return atIndex;
  return current.find(shot => normalizedPrompt(shot.prompt) === wanted) ?? atIndex;
}

export const productionStoryboardTool: ToolDefinition = {
  name: 'production_storyboard',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isProductionToolConfig(config)) return buildUnavailableTool('production_storyboard', 'Studio Productions');
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        try {
          const current = await config.compositions.get(args.compositionId);
          const keeps = args.shots.flatMap(shot => (shot.keep ? [shot.keep] : []));
          const twice = keeps.find((id, index) => keeps.indexOf(id) !== index);
          if (twice) throw new ProductionToolError(`${twice} is kept twice; keep each shot once.`);
          const resolved = args.shots.map(shot => resolveShot(shot, current.shots));
          const totalMs = resolved.reduce((sum, { shot }) => sum + shot.durationMs, 0);
          if (totalMs > STUDIO_TIMELINE_LIMITS.maxDurationMs) {
            throw new ProductionToolError('the shots run longer than a production can.');
          }
          const kept = resolved.map(({ shot, source }, index) =>
            keepTakes(
              toShot(shot, index),
              source ?? previousShot(current.shots, shot.prompt, index),
              source !== undefined
            )
          );
          const shots = kept.map(({ shot }) => shot);
          const keptTakeIds = new Set(shots.flatMap(shot => shot.fileIds));
          const lost = current.shots
            .filter(shot => shot.fileIds.length > 0 && !shot.fileIds.every(fileId => keptTakeIds.has(fileId)))
            .map(shot => shot.id);
          if (!args.replace && lost.length > 0) {
            throw new ProductionToolError(
              `this storyboard changes or removes the prompts of ${lost.join(', ')}, which already have takes. ` +
                'Pass keep with their ids to keep their takes and clips. Replacing them makes new takes and ' +
                "clips, which spend this run's clip limit, so a shot past the limit is left a still; ask the user " +
                'before replacing them, then pass replace: true.'
            );
          }
          // generate_shot cuts a shot to its clip, so a longer shot would play a still or spend another clip from
          // the run's cap; replace does not allow it.
          const outgrown = kept.filter(({ clipDropped }) => clipDropped).map(({ shot }) => shot.id);
          if (outgrown.length > 0) {
            throw new ProductionToolError(
              `${outgrown.join(', ')} would run longer than its clip, which a shot with a clip cannot do. Keep it at ` +
                'its length: to fit a long voice line, move part of it to a neighbouring shot or shorten it. If the ' +
                'line must stay word for word and does not fit, ask the user which to do: split it over two shots, ' +
                'shorten it, or add a shot. Do not offer a longer clip; a clip cannot be lengthened.'
            );
          }
          const tooShort = shotsTooShortForVoice(current.timeline, current.shots, shots);
          if (!args.replace && tooShort.length > 0) {
            throw new ProductionToolError(
              tooShort
                .map(({ id, lineMs, roomMs }) => `${id}'s voice line runs ${lineMs} ms but would have ${roomMs} ms`)
                .join('; ') +
                '. Keep those shots long enough for their lines, or shorten the lines; pass replace: true to cut them.'
            );
          }
          const products = current.brandKit.productFileIds;
          const product = args.productFileId?.toLowerCase();
          const directorIds = new Set<string>(Object.values(DIRECTOR_TRACK_IDS));
          // The old cut's picture, captions, voice and effects were laid to the old shots, so a new storyboard
          // clears them; the music bed is laid to the whole cut, so it is kept (trimmed) rather than paid for again.
          const staleCut = current.timeline.tracks.some(track => directorIds.has(track.id) && track.clips.length > 0);
          await config.compositions.update(args.compositionId, {
            shots,
            ...(staleCut && {
              timeline: withDirectorTracks(
                current.timeline,
                { video: [], music: keptMusic(current.timeline, totalMs), voice: [], sfx: [], captions: [] },
                totalMs
              ),
            }),
            ...(args.brief && { brief: { ...current.brief, summary: args.brief } }),
            ...(product &&
              !products.includes(product) && {
                brandKit: {
                  ...current.brandKit,
                  productFileIds: [product, ...products].slice(0, STUDIO_COMPOSITION_LIMITS.brandProductFilesMax),
                },
              }),
          });
          return JSON.stringify({
            // Every storyboard renumbers its shots, so a kept shot reports the id it had, which is now stale.
            shots: shots.map((shot, index) => {
              const was = resolved[index]?.source?.id;
              return {
                id: shot.id,
                ...(was && was !== shot.id && { was }),
                title: shot.title,
                durationMs: shot.durationMs,
                ...(shot.fileIds.length > 0 && { takesKept: true }),
              };
            }),
            totalSeconds: totalMs / 1000,
            ...(lost.length > 0 && { takesDropped: lost }),
            next:
              'Call production_generate_shot to make the takes and clips; a shot that kept its takes is skipped ' +
              'unless it needs a clip.' +
              (staleCut
                ? " The old cut's voiceover and sound effects were cleared: call production_add_audio again with " +
                  'them, and with the music, which is remade only if the cut grew past it.'
                : ''),
          });
        } catch (error) {
          return describeProductionError(error);
        }
      },
      toolSchema: { name: 'production_storyboard', description, parameters: toToolParameters(schema) },
    };
  },
};
