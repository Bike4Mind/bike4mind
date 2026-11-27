import { z } from 'zod';
import {
  DIRECTOR_MAX_SHOTS,
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_TIMELINE_LIMITS,
  StudioFileIdSchema,
  withDirectorProduct,
  type StudioCharacter,
  type StudioShot,
} from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildUnavailableTool, toToolParameters } from '../generationJobTool';
import { isProductionToolConfig, type ProductionToolConfig } from './config';
import {
  DEFAULT_SHOT_DURATION_MS,
  DIRECTOR_TRACK_IDS,
  keptMusic,
  shotsTooShortForVoice,
  withDirectorTracks,
} from './layout';
import { CompositionIdArg, ProductionToolError, describeProductionError } from './shared';

export const STORYBOARD_MAX_SHOTS = DIRECTOR_MAX_SHOTS;
const limits = STUDIO_COMPOSITION_LIMITS;

const ShotArg = z.object({
  keep: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Current shot id (e.g. "shot-3") to carry over with its prompt, takes, clip and voice line; omit prompt. ' +
        'Other fields default to current; voiceLine "" removes it.'
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
    .describe('Image prompt for a new shot: subject, setting, light, camera, product. A new prompt makes new takes.'),
  durationSeconds: z.number().min(1).max(30).optional().describe('Length in the cut.'),
  voiceLine: z
    .string()
    .trim()
    .max(limits.shotVoiceLineMaxLength)
    .optional()
    .describe('Voiceover and caption, about 2 words per second; a longer line is cut.'),
  characters: z
    .array(z.string().trim().min(1).max(limits.characterNameMaxLength))
    .max(limits.brandCharactersMax)
    .optional()
    .describe(
      'Brand kit character names or ids in this shot, in reference order. Omit to keep the current; [] removes.'
    ),
});

const schema = z.object({
  compositionId: CompositionIdArg,
  brief: z
    .string()
    .trim()
    .min(1)
    .max(limits.briefSummaryMaxLength)
    .optional()
    .describe("The one-line brief to save, when the user gave one that isn't saved yet."),
  productFileId: StudioFileIdSchema.optional().describe(
    'Product photo (a Files id); saved to the brand kit behind any product look there, which stays first reference.'
  ),
  shots: z.array(ShotArg).min(1).max(STORYBOARD_MAX_SHOTS),
  rewriteLines: z
    .boolean()
    .optional()
    .describe(
      'Only when the user asked to reword or remove voice lines, incl. removing a shot or rewriting the ad. ' +
        'Without it every current line must stay word for word, though it may be split over shots.'
    ),
  replace: z
    .boolean()
    .optional()
    .describe(
      'Only when the user asked for new pictures: lets a shot with takes get a new prompt or be removed, and cuts ' +
        'voice lines a re-time leaves no room for.'
    ),
});
type StoryboardArgs = z.infer<typeof schema>;

const description =
  'Write the storyboard of a Studio production: every shot in order with its image prompt, length and voice line. ' +
  'Carry over each current shot you are not re-imagining with keep. Plan the shots as the system context says; an ad ' +
  'is about 4 shots for 15 seconds. Then call production_generate_shot.';

type ResolvedShot = {
  title: string;
  intent?: string;
  prompt?: string;
  durationMs: number;
  voiceLine?: string;
  characterIds?: string[];
};

/** Maps the director's character names or ids to kit character ids, refusing one the kit does not have. */
function resolveCharacterIds(names: readonly string[], kit: readonly StudioCharacter[]): string[] {
  const ids = names.map(name => {
    const wanted = name.toLowerCase();
    const byId = kit.filter(character => character.id.toLowerCase() === wanted);
    const matches = byId.length > 0 ? byId : kit.filter(character => character.name.toLowerCase() === wanted);
    if (matches.length > 1) {
      throw new ProductionToolError(
        `"${name}" is ambiguous: it matches characters ${matches.map(character => character.id).join(', ')}; pass an id.`
      );
    }
    const match = matches[0];
    if (!match) {
      throw new ProductionToolError(
        `"${name}" is not a saved character of this production; its characters are ${
          kit.map(character => `"${character.name}"`).join(', ') || 'none (the user adds them in the Brand kit)'
        }.`
      );
    }
    return match.id;
  });
  return [...new Set(ids)];
}

/**
 * A shot argument filled in from the current shot it keeps. The director often no longer has a shot's prompt in hand
 * on a follow-up turn, so keep is how it carries a shot over; a prompt with no spaces is a stand-in for one, not a
 * description of a frame, and is refused rather than turned into new takes.
 */
function resolveShot(
  shot: StoryboardArgs['shots'][number],
  current: readonly StudioShot[],
  kit: readonly StudioCharacter[]
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
  const characterIds = shot.characters ? resolveCharacterIds(shot.characters, kit) : source?.characterIds;
  return {
    shot: {
      title,
      ...(intent && { intent }),
      ...(prompt && { prompt }),
      durationMs,
      ...(voiceLine && { voiceLine }),
      ...(characterIds && characterIds.length > 0 && { characterIds }),
    },
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

const spokenWords = (line: string | undefined): string =>
  (line ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();

/** Current voice lines whose words are no longer said, in order, anywhere in the new storyboard. */
function linesDropped(current: readonly StudioShot[], next: readonly ResolvedShot[]): string[] {
  const said = ` ${next
    .map(shot => spokenWords(shot.voiceLine))
    .filter(Boolean)
    .join(' ')} `;
  return current.flatMap(shot => {
    const words = spokenWords(shot.voiceLine);
    return words && !said.includes(` ${words} `) ? [shot.voiceLine ?? ''] : [];
  });
}

/** A voice line this call gives to more than one shot; a repeat already in the composition is left alone. */
function repeatedLine(resolved: readonly { shot: ResolvedShot; source?: StudioShot }[]): string | undefined {
  const seen = new Map<string, { shot: ResolvedShot; fresh: boolean }>();
  for (const { shot, source } of resolved) {
    const words = spokenWords(shot.voiceLine);
    if (!words) continue;
    const fresh = words !== spokenWords(source?.voiceLine);
    const earlier = seen.get(words);
    if (earlier && (fresh || earlier.fresh)) return shot.voiceLine;
    if (!earlier) seen.set(words, { shot, fresh });
  }
  return undefined;
}

/** True when kept shots appear in a different order relative to each other than they do now. */
function reordersKeptShots(current: readonly StudioShot[], sources: readonly (StudioShot | undefined)[]): boolean {
  const positions = sources.flatMap(source => (source ? [current.indexOf(source)] : []));
  return positions.some((position, index) => index > 0 && position < positions[index - 1]);
}

/**
 * Runs that already moved shots. A director that loses track of its own storyboard call repeats it, and repeating
 * a swap undoes it, so a second reorder in one run is refused. Keyed by `runId` because every tool approval
 * resumes the run with a new config; in memory, so a resume on another container forgets it (best effort).
 */
const REORDERED_RUNS_MAX = 500;
const reorderedRunIds = new Set<string>();
const reorderedConfigs = new WeakMap<object, true>();

const hasReordered = (config: ProductionToolConfig): boolean =>
  config.runId ? reorderedRunIds.has(config.runId) : reorderedConfigs.has(config);

const markReordered = (config: ProductionToolConfig): void => {
  if (!config.runId) {
    reorderedConfigs.set(config, true);
    return;
  }
  reorderedRunIds.add(config.runId);
  // Sets iterate in insertion order, so this drops the oldest run.
  const oldest = reorderedRunIds.values().next();
  if (reorderedRunIds.size > REORDERED_RUNS_MAX && !oldest.done) reorderedRunIds.delete(oldest.value);
};

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
          const resolved = args.shots.map(shot => resolveShot(shot, current.shots, current.brandKit.characters));
          const reorders = reordersKeptShots(
            current.shots,
            resolved.map(({ source }) => source)
          );
          if (reorders && hasReordered(config)) {
            throw new ProductionToolError(
              'this run already moved the shots with production_storyboard, so they are now in this order: ' +
                `${current.shots.map(shot => `${shot.id} "${shot.title}"`).join(', ')}. Calling it again with the ` +
                'same moves would undo them. Do not move shots again this run; carry on from this order.'
            );
          }
          const repeated = repeatedLine(resolved);
          if (repeated) {
            throw new ProductionToolError(
              `"${repeated}" is the voice line of more than one shot, so it would be said twice. Give each shot its ` +
                'own line, or no line.'
            );
          }
          const dropped = args.rewriteLines
            ? []
            : linesDropped(
                current.shots,
                resolved.map(({ shot }) => shot)
              );
          if (dropped.length > 0) {
            const reworded = resolved.flatMap(({ shot, source }) =>
              source?.voiceLine && spokenWords(source.voiceLine) !== spokenWords(shot.voiceLine) ? [source.id] : []
            );
            throw new ProductionToolError(
              `this storyboard no longer says these current voice lines word for word: ${dropped
                .map(line => `"${line}"`)
                .join(', ')}. Keep every line the user did not ask to change, word for word (you may split one ` +
                'over shots). If the user asked to reword or remove them, or to drop a shot or rewrite the ad for a new brief, ' +
                'pass rewriteLines: true.' +
                (reworded.length > 0
                  ? ` You gave ${reworded.join(', ')} a new voice line: if the user asked for that wording, call ` +
                    'production_storyboard again now with the same shots and rewriteLines: true, without asking them.'
                  : '')
            );
          }
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
          // The old voice and effects were laid to the old shots and add_audio keeps a part already laid, so a new
          // storyboard clears them. The picture and captions stay until production_assemble re-lays them, so a run
          // that stops before then leaves a cut that still plays; the music bed is kept (trimmed), not paid again.
          const staleCut = current.timeline.tracks.some(track => directorIds.has(track.id) && track.clips.length > 0);
          await config.compositions.update(args.compositionId, {
            shots,
            ...(staleCut && {
              timeline: withDirectorTracks(
                current.timeline,
                { music: keptMusic(current.timeline, totalMs), voice: [], sfx: [] },
                totalMs
              ),
            }),
            ...(args.brief && { brief: { ...current.brief, summary: args.brief } }),
            ...(product &&
              !products.includes(product) && {
                brandKit: { ...current.brandKit, productFileIds: withDirectorProduct(products, product) },
              }),
          });
          if (reorders) markReordered(config);
          const linesRemoved = args.rewriteLines
            ? linesDropped(
                current.shots,
                resolved.map(({ shot }) => shot)
              )
            : [];
          // A kept shot whose voice line changed: the user's own words may be gone, so the result names them.
          const linesChanged = resolved.flatMap(({ shot, source }) =>
            source?.voiceLine && source.voiceLine !== shot.voiceLine
              ? [{ shot: source.id, was: source.voiceLine, now: shot.voiceLine ?? '' }]
              : []
          );
          // keep carries a shot's line with its picture, so a reorder moves lines too; the user often meant only the
          // pictures, and the director has told them the lines stayed (QA saw this on swaps).
          const linesMoved = reorders
            ? resolved.flatMap(({ shot, source }, index) =>
                source?.voiceLine && shot.voiceLine === source.voiceLine && current.shots[index]?.id !== source.id
                  ? [
                      {
                        shot: shots[index]?.id ?? source.id,
                        says: shot.voiceLine,
                        before: current.shots[index]?.voiceLine ?? '',
                      },
                    ]
                  : []
              )
            : [];
          return JSON.stringify({
            // Every storyboard renumbers its shots, so a kept shot reports the id it had, which is now stale.
            shots: shots.map((shot, index) => {
              const was = resolved[index]?.source?.id;
              return {
                id: shot.id,
                ...(was && was !== shot.id && { was }),
                title: shot.title,
                durationMs: shot.durationMs,
                ...(shot.voiceLine && { voiceLine: shot.voiceLine }),
                ...(shot.characterIds && { characters: shot.characterIds }),
                ...(shot.fileIds.length > 0 && { takesKept: true }),
              };
            }),
            totalSeconds: totalMs / 1000,
            ...(lost.length > 0 && { takesDropped: lost }),
            ...(linesChanged.length > 0 && { linesChanged }),
            ...(linesRemoved.length > 0 && { linesRemoved }),
            ...(linesMoved.length > 0 && { linesMoved }),
            next:
              'Call production_generate_shot to make the takes and clips; a shot that kept its takes is skipped ' +
              'unless it needs a clip.' +
              (linesChanged.length > 0
                ? ' Tell the user each line in linesChanged as it now reads; never say a changed line was kept.'
                : '') +
              (linesRemoved.length > 0 ? ' Tell the user each line in linesRemoved is no longer said.' : '') +
              (linesMoved.length > 0
                ? ' Each line in linesMoved moved with its picture and is now said on that shot. If the user asked ' +
                  'for the lines to stay where they were, call production_storyboard again now with the shots in ' +
                  'this order (keep their new ids) and each one in linesMoved given voiceLine: its before; ' +
                  'otherwise tell the user which line each of those shots now says.'
                : '') +
              (staleCut
                ? " The old cut's voiceover and sound effects were cleared: call production_add_audio again with " +
                  'them, and with the music, which is remade only if the cut grew past it.'
                : ''),
          });
        } catch (error) {
          return describeProductionError(error, context.logger, 'production_storyboard');
        }
      },
      toolSchema: { name: 'production_storyboard', description, parameters: toToolParameters(schema) },
    };
  },
};
