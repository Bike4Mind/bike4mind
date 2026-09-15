/**
 * Response details shared by the endpoints that return generated audio as raw
 * bytes (music, sound effects). Not a contract - just the pieces both of their
 * contracts declare, kept in one place so the published media types and headers
 * cannot describe one endpoint and not the other.
 */

/**
 * Every Content-Type the ElevenLabs generators map an `output_format` token to
 * (`contentTypeForFormat` in ElevenLabsMusicGenerator / ElevenLabsSoundGenerator).
 * The first entry is the default (mp3); the rest are declared as alternates.
 * Must stay in sync with those two mappings.
 */
export const GENERATED_AUDIO_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/opus',
  'audio/L16',
  'audio/basic',
  'application/octet-stream',
] as const;

/**
 * Where the browsable copy of the generated audio ended up. These are the ONLY
 * channel for that information on these endpoints: the body is raw audio, so a
 * caller that wants the saved file has nowhere else to read it from.
 */
export const GENERATED_AUDIO_SAVE_HEADERS = {
  'X-B4M-Audio-Saved': 'Whether a browsable copy was saved to the file browser ("true"/"false").',
  'X-B4M-Audio-Fab-File-Id': 'Id of the saved file. Present only when the copy was saved.',
  'X-B4M-Audio-File-Name': 'File name of the saved copy. Present only when the copy was saved.',
  'X-B4M-Audio-File-Url':
    'Signed URL for the saved copy, minted at creation. Use this rather than re-resolving the file via ' +
    'GET /api/files/{id}, which fails closed until the async moderation scan completes.',
} as const;

/** The 200 response body of a raw-audio endpoint: default media type plus alternates. */
export const generatedAudioBody = () => ({
  contentType: GENERATED_AUDIO_CONTENT_TYPES[0],
  alsoReturns: GENERATED_AUDIO_CONTENT_TYPES.slice(1).map(contentType => ({ contentType })),
  headers: GENERATED_AUDIO_SAVE_HEADERS,
});
