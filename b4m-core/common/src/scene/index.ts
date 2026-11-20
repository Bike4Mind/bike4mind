import { z } from 'zod';

/**
 * A Scene is one shareable clip rendered from a video and a music track the caller already has (and optionally a
 * cover image). It is a rendered file, stored as its own generated asset with lineage to its inputs, not a recipe
 * that is re-rendered on read.
 */

/** `trim`: cut the audio at the video's end. `loop`: repeat the audio until the video ends. */
export const SCENE_AUDIO_FITS = ['trim', 'loop'] as const;
export type SceneAudioFit = (typeof SCENE_AUDIO_FITS)[number];

export const SCENE_MAX_FADE_SECONDS = 10;
export const SCENE_DEFAULT_FADE_IN_SECONDS = 0;
export const SCENE_DEFAULT_FADE_OUT_SECONDS = 1.5;
/** The Scene runs as long as its video, so this also bounds the output length. */
export const SCENE_MAX_VIDEO_SECONDS = 5 * 60;
/**
 * Sum of the input files' sizes; the worker downloads all of them to local disk. It bounds the worker, not what
 * Files keeps: a Scene over the per-file size limit is stored outside Files (ComposeJobOutput.filesSkipReason).
 */
export const SCENE_MAX_INPUT_BYTES = 200 * 1024 * 1024;
export const SCENE_TITLE_MAX_LENGTH = 200;

// Lowercase only: the ids land in FabFile lineage, whose guard rejects uppercase hex.
const FileIdSchema = z.string().regex(/^[0-9a-f]{24}$/, 'must be a lowercase 24-character hex file id');

export const SceneAudioOptionsSchema = z.strictObject({
  fit: z.enum(SCENE_AUDIO_FITS),
  fadeInSeconds: z.number().min(0).max(SCENE_MAX_FADE_SECONDS),
  fadeOutSeconds: z.number().min(0).max(SCENE_MAX_FADE_SECONDS),
});
export type SceneAudioOptions = z.infer<typeof SceneAudioOptionsSchema>;

/**
 * The request as persisted on the job: every default resolved, so an idempotent replay compares (and the worker
 * renders) exactly what was asked for.
 */
export const StoredSceneCompositionRequestSchema = z.strictObject({
  videoFileId: FileIdSchema,
  audioFileId: FileIdSchema,
  coverFileId: FileIdSchema.optional(),
  audio: SceneAudioOptionsSchema,
  title: z.string().trim().min(1).max(SCENE_TITLE_MAX_LENGTH).optional(),
});
export type StoredSceneCompositionRequest = z.infer<typeof StoredSceneCompositionRequestSchema>;

/** The caller's request (camelCase, the domain shape): `audio` and each of its fields may be omitted. */
export const SceneCompositionRequestSchema = StoredSceneCompositionRequestSchema.extend({
  audio: SceneAudioOptionsSchema.partial().optional(),
});
export type SceneCompositionRequest = z.infer<typeof SceneCompositionRequestSchema>;

export const toStoredSceneCompositionRequest = (request: SceneCompositionRequest): StoredSceneCompositionRequest => ({
  videoFileId: request.videoFileId,
  audioFileId: request.audioFileId,
  ...(request.coverFileId !== undefined && { coverFileId: request.coverFileId }),
  audio: {
    fit: request.audio?.fit ?? 'trim',
    fadeInSeconds: request.audio?.fadeInSeconds ?? SCENE_DEFAULT_FADE_IN_SECONDS,
    fadeOutSeconds: request.audio?.fadeOutSeconds ?? SCENE_DEFAULT_FADE_OUT_SECONDS,
  },
  ...(request.title !== undefined && { title: request.title }),
});

/** What each input must be, by the leading part of its stored mime type. */
export const SCENE_INPUT_MEDIA = {
  video: 'video/',
  audio: 'audio/',
  cover: 'image/',
} as const;
export type SceneInputSlot = keyof typeof SCENE_INPUT_MEDIA;
