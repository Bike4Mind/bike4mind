/**
 * A file produced by a quest tool (image_generation, edit_image, excel_generation, ...),
 * exposed to programmatic API consumers with a ready-to-use URL so they don't have to know
 * the CDN path convention. `isImage` lets a caller pick out renderable images without
 * re-parsing extensions - not every generated file is an image (excel_generation drops an
 * .xlsx into the same list).
 */
export type GeneratedFile = {
  name: string;
  url: string;
  isImage: boolean;
};

// Matches the extensions the web client treats as inline-renderable (PromptReplies.tsx).
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i;

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
    isImage: IMAGE_EXTENSION_RE.test(name),
  }));
}
