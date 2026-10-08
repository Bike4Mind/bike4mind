export interface RecentGeneratedImage {
  key: string;
  prompt: string;
}

export interface RecentGeneratedImagesNoteInput {
  /** edit_image reached the BUILT tool list (not just the requested one). */
  editImageAvailable: boolean;
  sessionOwnerId: string;
  callerId: string;
  recentImages: RecentGeneratedImage[] | undefined;
}

/**
 * The "Recently generated images" system note - gives the model a handle to edit a prior
 * generated image ("make it cartoonish"). Generated images persist as bare storage keys in
 * quest.images with no fabFile record, so without this note the model can't reference them and
 * either declines or (worse) claims success without calling a tool.
 *
 * Gated on edit_image reaching the built tool list: the requested list agrees today only because
 * edit_image is never auto-added, which is exactly the assumption that broke the view registry once
 * navigate_view became auto-added. Also gated on the caller owning the session: edit_image resolves
 * a generated key only for the session's owner (resolveOwnedGeneratedImageUrl), so a share
 * recipient must not be told to edit keys it would be refused.
 */
export function buildRecentGeneratedImagesNote({
  editImageAvailable,
  sessionOwnerId,
  callerId,
  recentImages,
}: RecentGeneratedImagesNoteInput): { role: 'system'; content: string }[] {
  if (!editImageAvailable || sessionOwnerId !== callerId || !recentImages?.length) return [];
  return [
    {
      role: 'system',
      content: [
        '# Recently generated images',
        '',
        'You generated these image(s) earlier in this conversation. To modify one (change style, angle, colors, etc.), call edit_image with `image` set to the EXACT id shown (for a previously generated image, that bare key is the handle to use):',
        '',
        ...recentImages.map(img => `- ${img.key}${img.prompt ? ` - from: "${img.prompt}"` : ''}`),
        '',
        'Never claim you created or edited an image unless image_generation or edit_image actually returned successfully in this turn.',
      ].join('\n'),
    },
  ];
}
