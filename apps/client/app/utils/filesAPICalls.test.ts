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
vi.mock('axios', () => ({
  default: {
    put: axiosPut,
    isCancel: () => false,
    isAxiosError: (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
  },
}));
vi.mock('./imageResizer', () => ({ resizeImageFile: vi.fn(), isImageFile: () => false }));

const { createFabFileOnServerWithUpload, chunkFileUtility, moderateFabFileNow } = await import('./filesAPICalls');

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

  it('declares the byte length it uploads, whatever size the caller passed', async () => {
    apiPost.mockResolvedValue({ data: { id: 'ff1', presignedUrl: '/api/files/ff1/upload', filePath: 'x.txt' } });

    await createFabFileOnServerWithUpload({ fileSize: 999 } as CreateFabFileRequestInputType, fakeFile);

    expect(apiPost.mock.calls[0][1]).toMatchObject({ fileSize: 11 });
  });

  it('hides a raw S3 XML body behind a generic message, keeping the original as the cause', async () => {
    apiPost.mockResolvedValue({ data: { id: 'ff1', presignedUrl: 'https://s3.example.invalid/x', filePath: 'x.txt' } });
    const s3Error = { isAxiosError: true, response: { status: 403, data: '<Error><Code>AccessDenied</Code></Error>' } };
    axiosPut.mockRejectedValue(s3Error);

    const rejection = createFabFileOnServerWithUpload(formData, fakeFile);

    await expect(rejection).rejects.toThrow('Failed to upload fab file');
    await expect(rejection).rejects.toMatchObject({ cause: s3Error });
  });

  it('passes a structured error through unchanged', async () => {
    apiPost.mockResolvedValue({ data: { id: 'ff1', presignedUrl: 'https://s3.example.invalid/x', filePath: 'x.txt' } });
    const apiError = { isAxiosError: true, response: { status: 500, data: { message: 'Upload proxy down' } } };
    axiosPut.mockRejectedValue(apiError);

    await expect(createFabFileOnServerWithUpload(formData, fakeFile)).rejects.toBe(apiError);
  });
});

describe('moderateFabFileNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts to the file's moderate route and returns the verdict", async () => {
    apiPost.mockResolvedValue({ data: { moderationStatus: 'clean' } });

    await expect(moderateFabFileNow('ff1')).resolves.toBe('clean');
    expect(apiPost).toHaveBeenCalledWith('/api/files/ff1/moderate');
  });

  it("degrades to 'pending' instead of throwing when the request fails", async () => {
    apiPost.mockRejectedValue(new Error('network'));

    await expect(moderateFabFileNow('ff1')).resolves.toBe('pending');
  });
});

describe('chunkFileUtility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when the chunk request fails so the mutation onError can fire', async () => {
    // A realistic rejection: the workbench holds a file that was deleted server-side, so the
    // route returns 404. (chunkSize 1000 is a normal valid value - the route has no upper ceiling.)
    apiPost.mockRejectedValue(new Error('Request failed with status code 404'));

    await expect(chunkFileUtility('ff1', 1000)).rejects.toThrow('status code 404');
  });

  it('resolves with the server payload on success', async () => {
    apiPost.mockResolvedValue({ data: { queued: true } });

    await expect(chunkFileUtility('ff1', 1000)).resolves.toEqual({ queued: true });
    expect(apiPost).toHaveBeenCalledWith('/api/files/chunk', { fabFileId: 'ff1', chunkSize: 1000 });
  });
});
