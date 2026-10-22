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

// Rendered videos (VideoGeneration writes .mp4 onto quest.videos). Disjoint from the audio set
// above, which leaves .webm to this one on purpose.
export const GENERATED_VIDEO_EXTENSION_RE = /\.(mp4|webm|mov)$/i;

// Storage keys of generated files, as the generation tools mint them (`${uuidv4()}.${ext}`).
// GENERATED_CONTENT_KEY_RE is what /api/generated-content/[ref] serves (any generated file);
// GENERATED_IMAGE_KEY_RE is the strict, lowercase image-only subset the image tools accept as an
// input (see resolveOwnedGeneratedImageUrl in @bike4mind/services). Neither admits a path separator.
// GENERATED_IMAGE_KEY_RE's extension set must stay in sync with EDITABLE_IMAGE_KEY_RE in
// @bike4mind/utils (llm/utils.ts), which picks the keys the "Recently generated images" note offers.
const GENERATED_KEY_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const GENERATED_CONTENT_KEY_RE = new RegExp(`^${GENERATED_KEY_UUID}\\.[a-z]+$`, 'i');
export const GENERATED_IMAGE_KEY_RE = new RegExp(`^${GENERATED_KEY_UUID}\\.(?:png|jpe?g|webp|gif)$`);
