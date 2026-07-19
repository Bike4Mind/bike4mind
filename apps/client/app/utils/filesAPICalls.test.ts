import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateFabFileRequestInputType } from '@bike4mind/common';

const { apiPost, apiPut, apiGet, apiDelete, axiosPut } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  axiosPut: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: apiPost, put: apiPut, get: apiGet, delete: apiDelete },
}));
vi.mock('axios', () => ({ default: { put: axiosPut, isCancel: () => false } }));
vi.mock('./imageResizer', () => ({ resizeImageFile: vi.fn(), isImageFile: () => false }));

const { createFabFileOnServerWithUpload } = await import('./filesAPICalls');

const formData = {} as unknown as CreateFabFileRequestInputType;
const fakeFile = { type: 'text/plain', size: 11 } as unknown as File;

describe('createFabFileOnServerWithUpload PUT routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({ data: { urls: [] } });
    apiPut.mockResolvedValue({ data: {} });
    axiosPut.mockResolvedValue({ data: {} });
  });

  it('sends a same-origin proxy URL (leading /) through the authenticated api client', async () => {
    apiPost.mockResolvedValue({
      data: { id: 'ff1', presignedUrl: '/api/files/ff1/upload', filePath: 'uploads/x.txt' },
    });

    await createFabFileOnServerWithUpload(formData, fakeFile);

    expect(apiPut).toHaveBeenCalledWith('/api/files/ff1/upload', fakeFile, expect.anything());
    expect(axiosPut).not.toHaveBeenCalled();
  });

  it('sends an absolute S3 presign through raw axios (no app auth)', async () => {
    apiPost.mockResolvedValue({
      data: { id: 'ff1', presignedUrl: 'https://s3.amazonaws.com/b/x?X-Amz=1', filePath: 'uploads/x.txt' },
    });

    await createFabFileOnServerWithUpload(formData, fakeFile);

    expect(axiosPut).toHaveBeenCalledWith('https://s3.amazonaws.com/b/x?X-Amz=1', fakeFile, expect.anything());
    expect(apiPut).not.toHaveBeenCalled();
  });
});
