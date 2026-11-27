import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFabFileOnServerWithUpload,
  deleteFileUtility,
  moderateFabFileNow,
} from '@client/app/utils/filesAPICalls';
import { EditMaskRejectedError, uploadEditMask } from './uploadEditMask';

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: vi.fn(),
  deleteFileUtility: vi.fn(),
  moderateFabFileNow: vi.fn(),
}));

const MASK_ID = 'a'.repeat(24);
const BASE64_MASK = btoa('mask-bytes');

describe('uploadEditMask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createFabFileOnServerWithUpload).mockResolvedValue({ id: MASK_ID } as Awaited<
      ReturnType<typeof createFabFileOnServerWithUpload>
    >);
    vi.mocked(deleteFileUtility).mockResolvedValue(undefined as Awaited<ReturnType<typeof deleteFileUtility>>);
  });

  it('uploads the mask as a PNG and returns it once the scan is clean', async () => {
    vi.mocked(moderateFabFileNow).mockResolvedValue('clean');

    await expect(uploadEditMask(BASE64_MASK)).resolves.toBe(MASK_ID);

    const [formData, file] = vi.mocked(createFabFileOnServerWithUpload).mock.calls[0];
    expect(formData).toMatchObject({ mimeType: 'image/png', fileSize: 'mask-bytes'.length });
    expect((file as File).type).toBe('image/png');
    expect(moderateFabFileNow).toHaveBeenCalledWith(MASK_ID);
    expect(deleteFileUtility).not.toHaveBeenCalled();
  });

  it('deletes a blocked mask and refuses the edit', async () => {
    vi.mocked(moderateFabFileNow).mockResolvedValue('blocked');

    const result = uploadEditMask(BASE64_MASK);

    await expect(result).rejects.toBeInstanceOf(EditMaskRejectedError);
    await expect(result).rejects.toThrow('blocked by moderation');
    expect(deleteFileUtility).toHaveBeenCalledWith(MASK_ID);
  });

  it('deletes a mask that is still pending and refuses the edit instead of sending it', async () => {
    vi.mocked(moderateFabFileNow).mockResolvedValue('pending');

    const result = uploadEditMask(BASE64_MASK);

    await expect(result).rejects.toBeInstanceOf(EditMaskRejectedError);
    await expect(result).rejects.toThrow('could not be checked just now');
    expect(deleteFileUtility).toHaveBeenCalledWith(MASK_ID);
  });

  it('still refuses the edit when deleting the rejected mask fails', async () => {
    vi.mocked(moderateFabFileNow).mockResolvedValue('blocked');
    vi.mocked(deleteFileUtility).mockRejectedValue(new Error('network'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(uploadEditMask(BASE64_MASK)).rejects.toBeInstanceOf(EditMaskRejectedError);
  });
});
