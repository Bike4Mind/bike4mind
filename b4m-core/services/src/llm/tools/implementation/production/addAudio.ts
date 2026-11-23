import { z } from 'zod';
import { isTerminalToolError } from '@bike4mind/llm-adapters';
import type { StudioAudioClip, StudioShot } from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildUnavailableTool, toToolParameters } from '../generationJobTool';
import { createProductionAudio } from './audio';
import {
  isProductionToolConfig,
  type ProductionAudioAdapter,
  type ProductionComposition,
  type ProductionToolConfig,
} from './config';
import { jobOutcome, musicReachMs, submitMusic, waitForJobs } from './jobs';
import {
  buildMusicClip,
  buildSfxClips,
  buildVoiceClips,
  directorClips,
  layoutShots,
  withDirectorTracks,
  musicShortfallMs,
  type PlacedAudio,
  type ShotSlot,
} from './layout';
import { CompositionIdArg, ProductionToolError, describeProductionError } from './shared';

type Context = Omit<ToolContext, 'config'>;

const AUDIO_PARTS = ['music', 'voiceover', 'soundEffects'] as const;
type AudioPart = (typeof AUDIO_PARTS)[number];
const SFX_MAX_SECONDS = 5;

const schema = z.object({
  compositionId: CompositionIdArg,
  music: z
    .object({ prompt: z.string().trim().min(1).max(1000) })
    .optional()
    .describe('An instrumental bed for the whole cut: genre, mood, tempo. Never name a real artist. Omit for none.'),
  voiceover: z.boolean().optional().describe("Speak each shot's voiceLine over that shot. Default true."),
  soundEffects: z
    .array(z.object({ shotId: z.string().min(1), prompt: z.string().trim().min(1).max(500) }))
    .max(12)
    .optional()
    .describe('At most one short effect per shot, played as the shot starts, e.g. "soft whoosh".'),
  replace: z
    .array(z.enum(AUDIO_PARTS))
    .optional()
    .describe('Parts to make again even though the timeline already has them. Each remake is charged again.'),
});
type AddAudioArgs = z.infer<typeof schema>;

const description =
  'Add sound to a Studio production: an instrumental music bed sized to the cut, a voiceover made from the ' +
  "shots' voice lines, and short sound effects, all placed on the timeline. A part already on the timeline is kept " +
  'unless named in `replace`, or, for music, unless the cut has grown past it. Run it after the shots are final (production_generate_shot), then call ' +
  'production_assemble.';

type Outcome<T> = { clips: T; notes: string[] };

// A clip sets its shot's length, and production_storyboard refuses to lengthen a shot past its clip.
const fitAdvice = (shot: StudioShot): string =>
  shot.clipFileId
    ? 'Shorten the line, or move part of it to the next shot, in production_storyboard (same prompts and lengths, so ' +
      'the takes and clips are kept), then replace the voiceover. A shot with a clip cannot be lengthened; if the ' +
      'line must stay word for word, ask the user whether to split it over two shots, shorten it, or add a shot.'
    : 'Shorten the line or lengthen the shot in production_storyboard (same prompts, so the takes are kept), then ' +
      'replace the voiceover.';

async function makeVoiceover(
  audio: ProductionAudioAdapter | null,
  slots: readonly ShotSlot[],
  totalMs: number
): Promise<Outcome<StudioAudioClip[]> & { cutLines: string[] }> {
  if (!audio) return { clips: [], notes: ['Voiceover is not available for this run.'], cutLines: [] };
  const lines: (PlacedAudio & { slot: ShotSlot })[] = [];
  const notes: string[] = [];
  for (const slot of slots.filter(candidate => candidate.shot.voiceLine)) {
    const result = await audio.speech({ text: slot.shot.voiceLine as string });
    if (result.ok)
      lines.push({ id: `${slot.shot.id}-voice`, fileId: result.fileId, durationMs: result.durationMs, slot });
    else notes.push(`voiceover for ${slot.shot.id} failed (${result.code}): ${result.message}`);
  }
  if (lines.length === 0 && notes.length === 0) notes.push('No shot has a voice line, so there is no voiceover.');
  const clips = buildVoiceClips(lines, totalMs);
  const cutLines: string[] = [];
  for (const line of lines) {
    const placed = clips.find(clip => clip.id === line.id);
    if (!placed || placed.durationMs < line.durationMs) {
      cutLines.push(line.slot.shot.id);
      notes.push(
        `the voice line for ${line.slot.shot.id} ("${line.slot.shot.voiceLine}") runs ${line.durationMs} ms, longer than the time it has; it is cut ` +
          `to ${placed?.durationMs ?? 0} ms. ${fitAdvice(line.slot.shot)}`
      );
    }
  }
  return { clips, notes, cutLines };
}

async function makeSoundEffects(
  audio: ProductionAudioAdapter | null,
  slots: readonly ShotSlot[],
  requests: NonNullable<AddAudioArgs['soundEffects']>
): Promise<Outcome<StudioAudioClip[]>> {
  if (!audio) return { clips: [], notes: ['Sound effects are not available for this run.'] };
  const effects: (PlacedAudio & { slot: ShotSlot })[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const { shotId, prompt } of requests) {
    const slot = slots.find(candidate => candidate.shot.id === shotId);
    if (!slot) throw new ProductionToolError(`no shot with id ${shotId}.`);
    if (seen.has(shotId)) continue;
    seen.add(shotId);
    const durationSeconds = Math.min(SFX_MAX_SECONDS, slot.durationMs / 1000);
    const result = await audio.soundEffect({ prompt, durationSeconds });
    if (result.ok) effects.push({ id: `${shotId}-sfx`, fileId: result.fileId, durationMs: result.durationMs, slot });
    else notes.push(`sound effect for ${shotId} failed (${result.code}): ${result.message}`);
  }
  return { clips: buildSfxClips(effects), notes };
}

async function makeMusic(
  context: Context,
  config: ProductionToolConfig,
  prompt: string,
  totalMs: number,
  underVoice: boolean
): Promise<Outcome<StudioAudioClip[]> & { pending?: string }> {
  const submitted = await submitMusic(context, config, { prompt, seconds: totalMs / 1000 });
  if (!submitted.ok) return { clips: [], notes: [`music not started: ${submitted.message}`] };
  const jobId = submitted.jobIds[0] as string;
  const job = (await waitForJobs(config, [jobId], context.getAbortSignal?.())).get(jobId);
  if (job?.state === 'succeeded' && job.fileId) {
    const durationMs = job.durationSeconds ? Math.round(job.durationSeconds * 1000) : totalMs;
    return {
      clips: [buildMusicClip({ id: 'music-bed', fileId: job.fileId, durationMs }, totalMs, underVoice)],
      notes: [],
    };
  }
  const outcome = jobOutcome(job);
  return outcome.startsWith('still')
    ? { clips: [], notes: [], pending: jobId }
    : { clips: [], notes: [`music ${outcome}`] };
}

const wants = (part: AudioPart, args: AddAudioArgs, existing: readonly unknown[]): boolean =>
  existing.length === 0 || (args.replace ?? []).includes(part);

async function addAudio(context: Context, config: ProductionToolConfig, args: AddAudioArgs): Promise<string> {
  const composition: ProductionComposition = await config.compositions.get(args.compositionId);
  const { slots, totalMs } = layoutShots(composition.shots);
  if (slots.length === 0) throw new ProductionToolError('the production has no shots; storyboard it first.');
  const timeline = composition.timeline;
  const replacements: Parameters<typeof withDirectorTracks>[1] = {};
  const notes: string[] = [];
  const audio = config.audio && createProductionAudio(context, config.audio);
  let pendingMusic: string | undefined;
  let cutLines: string[] = [];

  // Each part is paid for as it is made, so one part failing must not lose the others before they are saved.
  const attempt = async (part: AudioPart, make: () => Promise<void>): Promise<void> => {
    try {
      await make();
    } catch (error) {
      if (isTerminalToolError(error)) throw error;
      if (!(error instanceof ProductionToolError)) context.logger.error(`[production_add_audio] ${part} failed`, error);
      notes.push(`${part} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (args.voiceover !== false && wants('voiceover', args, directorClips(timeline, 'voice'))) {
    await attempt('voiceover', async () => {
      const voice = await makeVoiceover(audio, slots, totalMs);
      if (voice.clips.length > 0) replacements.voice = voice.clips;
      notes.push(...voice.notes);
      cutLines = voice.cutLines;
    });
  }
  if (args.soundEffects?.length && wants('soundEffects', args, directorClips(timeline, 'sfx'))) {
    const requests = args.soundEffects;
    await attempt('soundEffects', async () => {
      const sfx = await makeSoundEffects(audio, slots, requests);
      if (sfx.clips.length > 0) replacements.sfx = sfx.clips;
      notes.push(...sfx.notes);
    });
  }
  const musicShortMs = musicShortfallMs(timeline, musicReachMs(config, totalMs));
  const musicPrompt = args.music?.prompt;
  if (musicPrompt && (musicShortMs > 0 || wants('music', args, directorClips(timeline, 'music')))) {
    await attempt('music', async () => {
      const underVoice = (replacements.voice ?? directorClips(timeline, 'voice')).length > 0;
      const music = await makeMusic(context, config, musicPrompt, totalMs, underVoice);
      if (music.clips.length > 0) {
        replacements.music = music.clips;
        if (musicShortMs > 0)
          notes.push(`the music bed ended ${musicShortMs} ms before the cut, so a new one was made.`);
      }
      notes.push(...music.notes);
      pendingMusic = music.pending;
    });
  }

  if (Object.keys(replacements).length > 0) {
    // Re-read so a write since this call started (say, the editor's) is the base the audio lands on.
    const fresh = await config.compositions.get(args.compositionId);
    await config.compositions.update(args.compositionId, {
      timeline: withDirectorTracks(fresh.timeline, replacements, totalMs),
    });
  }
  return JSON.stringify({
    added: Object.fromEntries(Object.entries(replacements).map(([kind, clips]) => [kind, clips?.length ?? 0])),
    ...(notes.length > 0 && { notes }),
    ...(cutLines.length > 0 && { cutLines }),
    next: pendingMusic
      ? 'The music is still rendering: call production_add_audio again with the same arguments to wait for it.'
      : cutLines.length > 0
        ? `The voice lines of ${cutLines.join(', ')} are cut short (see notes). Fit them and replace the voiceover, ` +
          'or call production_assemble and tell the user which lines are cut, quoting them from the notes; never ' +
          'say a cut line fits.'
        : 'Call production_assemble to lay out the cut.',
  });
}

export const productionAddAudioTool: ToolDefinition = {
  name: 'production_add_audio',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isProductionToolConfig(config)) return buildUnavailableTool('production_add_audio', 'Studio Productions');
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        try {
          return await addAudio(context, config, args);
        } catch (error) {
          return describeProductionError(error, context.logger, 'production_add_audio');
        }
      },
      toolSchema: { name: 'production_add_audio', description, parameters: toToolParameters(schema) },
    };
  },
};
