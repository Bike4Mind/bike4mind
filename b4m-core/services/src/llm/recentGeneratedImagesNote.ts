export type RecentGeneratedImage = { key: string; prompt: string };
/** A finished image job's output: a regular file the caller owns, so both tools take its id as a file id. */
export type RecentImageJobFile = { fileId: string; prompt: string };

export type RecentGeneratedImagesNoteInput = {
  images: readonly RecentGeneratedImage[] | undefined;
  /** Outputs of image jobs recent turns started (ChatCompletionProcess resolves them owner-scoped). */
  imageJobFiles?: readonly RecentImageJobFile[];
  /** Whether each tool reached the BUILT tool list, not merely the requested one. */
  editImageAvailable: boolean;
  videoGenerationAvailable: boolean;
  sessionOwnerId: string;
  callerId: string;
};

/**
 * The "Recently generated images" system note: gives the model a handle on images it generated earlier.
 * Generated images persist as bare storage keys in quest.images with no fabFile record, so without this
 * note the model cannot reference them and either declines or (worse) claims success without calling a
 * tool. Image-job outputs (chat's image tools on the job engine) are listed by file id beside the keys.
 * Empty unless a tool that consumes the ids (edit_image, video_generation) is offered, and it
 * only names the tools that are. Also empty unless the caller owns the session: both tools resolve a
 * generated key only for the session's owner (callerOwnsGeneratedImage), so a share recipient must not
 * be told to pass keys it would be refused.
 */
export function buildRecentGeneratedImagesNote({
  images,
  imageJobFiles,
  editImageAvailable,
  videoGenerationAvailable,
  sessionOwnerId,
  callerId,
}: RecentGeneratedImagesNoteInput): { role: 'system'; content: string }[] {
  const keys = images ?? [];
  const files = imageJobFiles ?? [];
  if (keys.length === 0 && files.length === 0) return [];
  if (!editImageAvailable && !videoGenerationAvailable) return [];
  if (sessionOwnerId !== callerId) return [];

  const withPrompt = (id: string, prompt: string) => `- ${id}${prompt ? ` - from: "${prompt}"` : ''}`;
  const keySection =
    keys.length === 0
      ? []
      : [
          'Each bare key below is the id of an image you generated; pass the EXACT id shown:',
          ...(editImageAvailable
            ? ['- To modify one (change style, angle, colors, etc.), call edit_image with `image` set to its id.']
            : []),
          ...(videoGenerationAvailable
            ? ['- To animate one into a video clip, call video_generation with `inputGeneratedImageKey` set to its id.']
            : []),
          '',
          ...keys.map(image => withPrompt(image.key, image.prompt)),
          '',
        ];
  const fileSection =
    files.length === 0
      ? []
      : [
          'Each file id below is an image you generated, saved to the user files; pass the EXACT id shown:',
          ...(editImageAvailable
            ? ['- To modify one (change style, angle, colors, etc.), call edit_image with `image` set to its file id.']
            : []),
          ...(videoGenerationAvailable
            ? ['- To animate one into a video clip, call video_generation with `inputImageFileId` set to its file id.']
            : []),
          '',
          ...files.map(file => withPrompt(file.fileId, file.prompt)),
          '',
        ];
  const content = [
    '# Recently generated images',
    '',
    'You generated these image(s) earlier in this conversation.',
    ...keySection,
    ...fileSection,
    'Never claim you created or edited an image unless image_generation or edit_image actually returned successfully in this turn.',
  ].join('\n');
  return [{ role: 'system', content }];
}
