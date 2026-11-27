// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockPost, mockUploadFileToUrl } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockUploadFileToUrl: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost } }));
vi.mock('./uploadFileToUrl', () => ({ uploadFileToUrl: mockUploadFileToUrl }));

import { useUploadProfilePhoto } from './userAPICalls';

const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const variables = {
  userId: 'u1',
  fileInfo: { fileName: 'a.png', fileSize: 3, mimeType: 'image/png' },
  file: new Blob(['abc'], { type: 'image/png' }),
};

beforeEach(() => {
  queryClient.clear();
  invalidateQueries.mockClear();
  mockPost.mockReset().mockResolvedValue({ data: { url: 'https://signed', fileId: 'f1', fileKey: 'k' } });
  mockUploadFileToUrl.mockReset().mockResolvedValue(undefined);
});

describe('useUploadProfilePhoto', () => {
  it('confirms the photo only after the file has been uploaded', async () => {
    let completeUpload: () => void = () => {
      throw new Error('Upload was not initialized');
    };
    mockUploadFileToUrl.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          completeUpload = resolve;
        })
    );
    const { result } = renderHook(() => useUploadProfilePhoto(), { wrapper });

    result.current.mutate(variables);
    await waitFor(() => expect(mockUploadFileToUrl).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result.current.isSuccess).toBe(false);

    completeUpload();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockPost.mock.calls.map(c => c[0])).toEqual(['/api/users/u1/upload-photo', '/api/users/u1/confirm-photo']);
    expect(mockPost).toHaveBeenLastCalledWith('/api/users/u1/confirm-photo', { fileId: 'f1' });
    expect(mockUploadFileToUrl.mock.invocationCallOrder[0]).toBeLessThan(mockPost.mock.invocationCallOrder[1]);
    expect(result.current.data).toBe('f1');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['users'] });
  });

  it('reports an error when confirmation fails', async () => {
    const confirmationError = new Error('Confirmation failed');
    mockPost
      .mockResolvedValueOnce({ data: { url: 'https://signed', fileId: 'f1', fileKey: 'k' } })
      .mockRejectedValueOnce(confirmationError);
    const { result } = renderHook(() => useUploadProfilePhoto(), { wrapper });

    result.current.mutate(variables);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockPost).toHaveBeenLastCalledWith('/api/users/u1/confirm-photo', { fileId: 'f1' });
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.error).toBe(confirmationError);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('never confirms when the upload fails', async () => {
    mockUploadFileToUrl.mockRejectedValue(new Error('PUT failed'));
    const { result } = renderHook(() => useUploadProfilePhoto(), { wrapper });

    result.current.mutate(variables);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).not.toHaveBeenCalledWith('/api/users/u1/confirm-photo', expect.anything());
  });
});
