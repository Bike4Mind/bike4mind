import type {
  AudioGenerationToolCall,
  GenerationJobState,
  StudioCompositionContent,
  StudioCompositionUpdateInput,
  ReferenceImageState,
} from '@bike4mind/common';
import { hasAudioToolJobs, type AudioToolJobs } from '../audioGeneration';
import type { ImageToolConfig } from '../imageGeneration/imageJobTool';
import type { MusicToolConfig } from '../musicGeneration';
import type { VideoToolConfig } from '../videoGeneration';

export const PRODUCTION_TOOL_NAMES = [
  'production_storyboard',
  'production_generate_shot',
  'production_add_audio',
  'production_assemble',
] as const;
export type ProductionToolName = (typeof PRODUCTION_TOOL_NAMES)[number];

export type ProductionComposition = StudioCompositionContent & { id: string };

/** A generation job as the director tools read it back: enough to wait on it and place its output. */
export type ProductionJobView = {
  id: string;
  state: GenerationJobState;
  fileId?: string;
  durationSeconds?: number;
  error?: { code: string; message: string } | null;
};

export type ProductionAudioResult =
  { ok: true; fileId: string; durationMs: number } | { ok: false; code: string; message: string };

/** The user's saved audio settings and the run's speech and sound-effect job functions (capped per run). */
export type ProductionAudioSettings = Partial<AudioGenerationToolCall> & { jobs: AudioToolJobs };

/**
 * Speech and sound effects for a production, each one a speech or sound_effect generation job that holds and
 * settles its own credits and saves the clip to the user's Files. Code `pending` means it is still running.
 */
export type ProductionAudioAdapter = {
  speech(input: { text: string }): Promise<ProductionAudioResult>;
  soundEffect(input: { prompt: string; durationSeconds: number }): Promise<ProductionAudioResult>;
};

/**
 * One config shared by the four director tools. The host binds every member to the run's user, so a composition
 * or job the user does not own reads as missing. A null media member leaves that step unavailable rather than
 * failing the whole production.
 */
export type ProductionToolConfig = {
  compositions: {
    /** Throws a NotFoundError for a missing composition or another user's. */
    get(id: string): Promise<ProductionComposition>;
    /** Replaces each given field whole; throws an UnprocessableEntityError carrying `issues` when invalid. */
    update(id: string, input: StudioCompositionUpdateInput): Promise<ProductionComposition>;
  };
  /** Capped image jobs (agentImagesPerRun). */
  image: ImageToolConfig | null;
  /** Usable image models that take reference inputs in generate mode, best first. */
  imageModels: readonly string[];
  /** Capped video jobs (agentVideoClipsPerRun). */
  video: VideoToolConfig | null;
  /** Capped music jobs (agentMusicTracksPerRun). */
  music: MusicToolConfig | null;
  /** Null leaves voiceover and sound effects unavailable this run. */
  audio: ProductionAudioSettings | null;
  /** The run user's jobs among `ids`; others are left out. */
  findJobs(ids: readonly string[]): Promise<ProductionJobView[]>;
  /**
   * The files among `ids` an image job will take from the run user as references (referenceImageState in
   * @bike4mind/common), with their state; others are left out.
   */
  referenceImages(ids: readonly string[]): Promise<ReadonlyMap<string, ReferenceImageState>>;
  /**
   * Stable across the run's Lambda handoffs (the host rebuilds this object on every resume), so per-run guards key
   * by it; without it they fall back to this object.
   */
  runId?: string;
  /** How long one tool call waits for its jobs before handing back what is still running. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  /** How long a clip waits for a new take to clear moderation before reporting it pending. */
  inputReadyTimeoutMs?: number;
};

export const isProductionToolConfig = (value: unknown): value is ProductionToolConfig =>
  typeof value === 'object' &&
  value !== null &&
  'compositions' in value &&
  typeof value.compositions === 'object' &&
  value.compositions !== null &&
  'get' in value.compositions &&
  typeof value.compositions.get === 'function' &&
  'update' in value.compositions &&
  typeof value.compositions.update === 'function' &&
  'imageModels' in value &&
  Array.isArray(value.imageModels) &&
  'findJobs' in value &&
  typeof value.findJobs === 'function' &&
  'referenceImages' in value &&
  typeof value.referenceImages === 'function' &&
  'audio' in value &&
  (value.audio === null || hasAudioToolJobs(value.audio));
