// Each provider adapter PR appends its id here.
export const MUSIC_PROVIDER_IDS = ['test', 'gemini-lyria', 'elevenlabs'] as const;
export type MusicProviderId = (typeof MUSIC_PROVIDER_IDS)[number];

export const MUSIC_OUTPUT_FORMATS = ['mp3'] as const;
export type MusicOutputFormat = (typeof MUSIC_OUTPUT_FORMATS)[number];

/**
 * How the caller's `durationSeconds` reaches the model, in whole seconds:
 * - exact: a provider parameter; the output length is billed on.
 * - approximate: steered by the prompt only, so the output may run shorter or longer.
 * - fixed: every output has this length; a request may omit it or repeat it.
 */
export type MusicDurationCapability =
  | { control: 'exact'; min: number; max: number; default: number }
  | { control: 'approximate'; min: number; max: number; default: number }
  | { control: 'fixed'; seconds: number };

/** `per_song` is flat whatever the length (a 30 s clip is a song); `per_second` bills the output length. */
export type MusicPricing = { unit: 'per_song'; usd: number } | { unit: 'per_second'; usd: number };

export type MusicModelCapabilities = {
  provider: MusicProviderId;
  displayName: string;
  /** 'optional': sings unless the request sets instrumental; 'never': instrumental only. */
  vocals: 'optional' | 'never';
  /** null when the model only writes its own lyrics (or sings none). `maxLineChars` when the provider caps a line. */
  lyrics: { maxChars: number; maxLineChars?: number } | null;
  duration: MusicDurationCapability;
  outputFormats: readonly MusicOutputFormat[];
  // Rough wall-clock render time, only used to set the agent's and the studio's expectation. Not billed on.
  typicalRenderSeconds: number;
  pricing: MusicPricing;
  // Labelled preview by its provider: may change or be retired at short notice.
  preview: boolean;
  // Admin setting `musicGeneration.enabledModels[id]` overrides this.
  defaultEnabled: boolean;
  deprecationDate?: string;
};
