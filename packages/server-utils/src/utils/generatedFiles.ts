import {
  type GeneratedFile,
  GENERATED_AUDIO_EXTENSION_RE,
  GENERATED_IMAGE_EXTENSION_RE,
  GENERATED_VIDEO_EXTENSION_RE,
} from '@bike4mind/common';
import { signGeneratedMediaUrls } from '@bike4mind/server-utils/utils/generatedMediaUrls';

/**
 * Map bare generated-file basenames (as stored on `quest.images`) to descriptors with ready-to-use,
 * short-lived presigned URLs (GENERATED_MEDIA_URL_TTL_SECONDS), so API consumers don't have to know
 * the storage layout. The caller must already have authorized reading the quest these names came from.
 * Not every generated file is an image (excel_generation drops an .xlsx, music_generation an .mp3,
 * into the same list), so `isImage`/`isAudio`/`isVideo` pick out renderable media; a file matches at
 * most one flag. The shape is GeneratedFileSchema (common/schemas/quest.ts), the `files` entry of the
 * poll body.
 */
export async function toGeneratedFiles(names: string[]): Promise<GeneratedFile[]> {
  if (names.length === 0) return [];
  const urls = await signGeneratedMediaUrls(names);
  return names.map(name => ({
    name,
    url: urls[name],
    isImage: GENERATED_IMAGE_EXTENSION_RE.test(name),
    isAudio: GENERATED_AUDIO_EXTENSION_RE.test(name),
    isVideo: GENERATED_VIDEO_EXTENSION_RE.test(name),
  }));
}
