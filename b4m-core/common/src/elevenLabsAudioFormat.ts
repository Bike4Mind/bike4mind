/**
 * ElevenLabs `output_format` tokens (`<codec>_<sampleRate>[_<bitrate>]`, e.g. `mp3_44100_128`) for the
 * music and sound-effects generators. Keyed by codec, so the provider's per-tier sample-rate/bitrate
 * variants need no entry here. A codec missing from this map is refused at the route, before any credit
 * is reserved: its audio could not be labelled with a real MIME type, so it could be neither saved nor
 * served, yet would still be billed.
 */
const ELEVENLABS_CODEC_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  pcm: 'audio/L16',
  ulaw: 'audio/basic',
} as const satisfies Record<string, string>;

type ElevenLabsCodec = keyof typeof ELEVENLABS_CODEC_CONTENT_TYPES;

export const ELEVENLABS_AUDIO_CODECS = Object.keys(ELEVENLABS_CODEC_CONTENT_TYPES) as ElevenLabsCodec[];

/** Every Content-Type an ElevenLabs music or sound-effects generation can return. */
export const ELEVENLABS_AUDIO_CONTENT_TYPES = Object.values(ELEVENLABS_CODEC_CONTENT_TYPES);

const isElevenLabsCodec = (codec: string): codec is ElevenLabsCodec =>
  Object.prototype.hasOwnProperty.call(ELEVENLABS_CODEC_CONTENT_TYPES, codec);

/** The MIME type for an ElevenLabs `output_format` token, or `undefined` when its codec is unsupported. */
export function elevenLabsContentTypeForFormat(format: string): string | undefined {
  const [codec] = format.split('_', 1);
  return isElevenLabsCodec(codec) ? ELEVENLABS_CODEC_CONTENT_TYPES[codec] : undefined;
}

export function isSupportedElevenLabsFormat(format: string): boolean {
  return elevenLabsContentTypeForFormat(format) !== undefined;
}
