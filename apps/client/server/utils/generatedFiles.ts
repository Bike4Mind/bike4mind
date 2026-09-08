import { GENERATED_AUDIO_EXTENSION_RE, GENERATED_IMAGE_EXTENSION_RE } from '@bike4mind/common';

/**
 * A file produced by a quest tool (image_generation, edit_image, excel_generation,
 * music_generation, ...), exposed to programmatic API consumers with a ready-to-use URL
 * so they don't have to know the CDN path convention. `isImage`/`isAudio` let a caller
 * pick out renderable media without re-parsing extensions - not every generated file is
 * an image (excel_generation drops an .xlsx, music_generation an .mp3, into the same
 * list). A file matches at most one flag; everything else is a plain download.
 */
export type GeneratedFile = {
  name: string;
  url: string;
  isImage: boolean;
  isAudio: boolean;
};

/**
 * Map bare generated-file basenames (as stored on `quest.images`) to descriptors with
 * fully-qualified CDN URLs. Generated files are served under `<cdnUrl>/generated/<name>`.
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
  }));
}
