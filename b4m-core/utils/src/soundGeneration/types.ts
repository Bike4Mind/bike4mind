export interface SoundGenerationOptions {
  /** Target clip length in seconds. The provider clamps to its own range. */
  durationSeconds?: number;
  /** 0-1: how strictly the provider follows the prompt vs. its own creativity. */
  promptInfluence?: number;
  /** Provider-specific output encoding token (e.g. ElevenLabs `mp3_44100_128`). */
  format?: string;
}

export interface GeneratedSound {
  audio: Buffer;
  /** MIME type of `audio`, derived from the requested output format. */
  contentType: string;
}

/**
 * Turns a text prompt into a one-shot sound effect. Deliberately a single
 * method so vendors that only generate (and don't edit/stream) aren't forced
 * to stub out methods they can't support.
 */
export interface SoundGenerator {
  generate(text: string, options?: SoundGenerationOptions): Promise<GeneratedSound>;
}
