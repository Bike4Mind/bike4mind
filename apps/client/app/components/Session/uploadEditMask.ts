import { KnowledgeType } from '@bike4mind/common';
import {
  createFabFileOnServerWithUpload,
  deleteFileUtility,
  moderateFabFileNow,
} from '@client/app/utils/filesAPICalls';

/** A mask that is not usable for an edit; its message is safe to show the user. */
export class EditMaskRejectedError extends Error {}

const base64PngToFile = (base64Mask: string): File => {
  const byteString = atob(base64Mask);
  const bytes = new Uint8Array(byteString.length);
  for (let index = 0; index < byteString.length; index++) {
    bytes[index] = byteString.charCodeAt(index);
  }
  return new File([bytes], `image_mask_${Date.now()}.png`, { type: 'image/png' });
};

/**
 * Saves the in-chat masker's mask as a FabFile and scans it before it is sent, as Studio's mask painter does
 * (ImageStudio/ImageMaskPainter.tsx): an image job refuses an input that is not 'clean', so a blocked or still
 * pending mask is deleted here and the edit is not sent.
 */
export async function uploadEditMask(base64Mask: string): Promise<string> {
  const file = base64PngToFile(base64Mask);
  const saved = await createFabFileOnServerWithUpload(
    { type: KnowledgeType.FILE, fileName: file.name, mimeType: 'image/png', fileSize: file.size },
    file
  );
  const scan = await moderateFabFileNow(saved.id);
  if (scan === 'clean') return saved.id;

  try {
    await deleteFileUtility(saved.id);
  } catch (deleteError) {
    console.error('Failed to delete an unusable edit mask: ', deleteError);
  }
  throw new EditMaskRejectedError(
    scan === 'blocked'
      ? 'The edit mask was blocked by moderation. Please try again.'
      : 'The edit mask could not be checked just now. Try the edit again in a moment.'
  );
}
