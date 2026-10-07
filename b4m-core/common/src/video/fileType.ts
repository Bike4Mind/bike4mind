// The container formats a stored clip may claim. Providers report the content type of their output, and
// storage trusts that claim over the file name, so anything outside this list is not stored as a video.
const EXTENSION_BY_VIDEO_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** The file extension for a stored clip's content type, or null when the type is not a supported video. */
export const videoFileExtension = (contentType: string): string | null =>
  EXTENSION_BY_VIDEO_CONTENT_TYPE[contentType.toLowerCase()] ?? null;
