export type RecentGeneratedImage = { key: string; prompt: string };

export type RecentGeneratedImagesNoteInput = {
  images: readonly RecentGeneratedImage[] | undefined;
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
 * tool. Empty unless a tool that consumes the keys (edit_image, video_generation) is offered, and it
 * only names the tools that are. Also empty unless the caller owns the session: both tools resolve a
 * generated key only for the session's owner (callerOwnsGeneratedImage), so a share recipient must not
 * be told to pass keys it would be refused.
 */
export function buildRecentGeneratedImagesNote({
  images,
  editImageAvailable,
  videoGenerationAvailable,
  sessionOwnerId,
  callerId,
}: RecentGeneratedImagesNoteInput): { role: 'system'; content: string }[] {
  if (!images || images.length === 0) return [];
  if (!editImageAvailable && !videoGenerationAvailable) return [];
  if (sessionOwnerId !== callerId) return [];

  const uses = [
    ...(editImageAvailable
      ? ['- To modify one (change style, angle, colors, etc.), call edit_image with `image` set to its id.']
      : []),
    ...(videoGenerationAvailable
      ? ['- To animate one into a video clip, call video_generation with `inputGeneratedImageKey` set to its id.']
      : []),
  ];
  const content = [
    '# Recently generated images',
    '',
    'You generated these image(s) earlier in this conversation. Each bare key below is the id of that image; pass the EXACT id shown:',
    ...uses,
    '',
    ...images.map(image => `- ${image.key}${image.prompt ? ` - from: "${image.prompt}"` : ''}`),
    '',
    'Never claim you created or edited an image unless image_generation or edit_image actually returned successfully in this turn.',
  ].join('\n');
  return [{ role: 'system', content }];
}
