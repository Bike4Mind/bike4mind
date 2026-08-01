import { MusicModel } from '@bike4mind/common';

export interface MusicGenerationOptions {
  /** Target track length in ms. Bounded by the route to fit the serving-function
   * budget (see MAX_MUSIC_LENGTH_MS); the provider's own range is 3s-600s. */
  lengthMs?: number;
  /** When true, ask the provider for an instrumental (no vocals) track. */
  forceInstrumental?: boolean;
  /** Provider model id (e.g. ElevenLabs `music_v1`). */
  modelId?: MusicModel;
  /** Provider-specific output encoding token (e.g. ElevenLabs `mp3_44100_128`). */
  format?: string;
}

export interface GeneratedMusic {
  audio: Buffer;
  /** MIME type of `audio`, derived from the requested output format. */
  contentType: string;
}

/**
 * Turns a text prompt into a background-music track. Deliberately a single
 * method so vendors that only generate (and don't edit/stream) aren't forced
 * to stub out methods they can't support.
 */
export interface MusicGenerator {
  generate(prompt: string, options?: MusicGenerationOptions): Promise<GeneratedMusic>;
}
