/**
 * Extension sets for files a quest tool drops onto `quest.images` (image_generation,
 * edit_image, music_generation, audio_generation, excel_generation, ...). Single source of
 * truth shared by the web renderer (PromptReplies.classifyGeneratedFiles) and the API file
 * classifier (server/utils/generatedFiles), so the two never drift on how a generated file
 * renders. Browser-safe (regex literals only) - importable from either build.
 */

// Actual raster/vector images belong in the inline <img> grid; anything else (e.g. an
// .xlsx from excel_generation) would render as a broken image.
export const GENERATED_IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i;

// Generated audio that plays inline in a browser <audio> element. .opus is a
// browser-playable container; raw .pcm is omitted (no container the <audio> element can
// decode). .webm/.ogg are omitted because both are predominantly video containers - a
// future generated-video path through quest.images must not be claimed here for the audio
// player.
export const GENERATED_AUDIO_EXTENSION_RE = /\.(mp3|wav|m4a|aac|flac|opus)$/i;
