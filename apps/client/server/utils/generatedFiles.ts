import {
  type GeneratedFile,
  GENERATED_AUDIO_EXTENSION_RE,
  GENERATED_IMAGE_EXTENSION_RE,
  GENERATED_VIDEO_EXTENSION_RE,
} from '@bike4mind/common';

/**
 * Map bare generated-file basenames (as stored on `quest.images`) to descriptors with
 * fully-qualified CDN URLs, so API consumers don't have to know the CDN path convention.
 * Generated files are served under `<cdnUrl>/generated/<name>`. Not every generated file is an
 * image (excel_generation drops an .xlsx, music_generation an .mp3, into the same list), so
 * `isImage`/`isAudio`/`isVideo` pick out renderable media; a file matches at most one flag.
 * The shape is GeneratedFileSchema (common/schemas/quest.ts), the `files` entry of the poll body.
 * Returns [] when no CDN is configured rather than emit a misleading relative path.
 */
export function toGeneratedFiles(names: string[]): GeneratedFile[] {
  const cdnUrl = (process.env.NEXT_PUBLIC_CDN_URL || '').replace(/\/+$/, '');
  if (!cdnUrl) {
    return [];
  }
  return names.map(name => ({
    name,
    url: `${cdnUrl}/generated/${name}`,
    isImage: GENERATED_IMAGE_EXTENSION_RE.test(name),
    isAudio: GENERATED_AUDIO_EXTENSION_RE.test(name),
    isVideo: GENERATED_VIDEO_EXTENSION_RE.test(name),
  }));
}
