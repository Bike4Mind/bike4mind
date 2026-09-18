import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    post: vi.fn(),
  },
}));

import { AxiosError } from 'axios';
import { uploadBlogImage, generatePostIdFromTitle, getBlogUploadErrorMessage } from '../blogImageUpload';
import { api } from '@client/app/contexts/ApiContext';

function axiosErrorWith(data: unknown): AxiosError {
  return new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
    data,
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: {} as never,
  });
}

describe('blogImageUpload', () => {
  describe('generatePostIdFromTitle', () => {
    it('converts title to lowercase', () => {
      expect(generatePostIdFromTitle('Hello World')).toBe('hello-world');
    });

    it('replaces spaces with hyphens', () => {
      expect(generatePostIdFromTitle('my blog post')).toBe('my-blog-post');
    });

    it('removes special characters', () => {
      expect(generatePostIdFromTitle("Hello! World? It's Great")).toBe('hello-world-its-great');
    });

    it('collapses multiple hyphens', () => {
      expect(generatePostIdFromTitle('Hello   World')).toBe('hello-world');
      expect(generatePostIdFromTitle('Hello - - World')).toBe('hello-world');
    });

    it('removes leading and trailing hyphens', () => {
      expect(generatePostIdFromTitle('  Hello World  ')).toBe('hello-world');
      expect(generatePostIdFromTitle('-Hello World-')).toBe('hello-world');
    });

    it('handles empty string', () => {
      expect(generatePostIdFromTitle('')).toBe('');
    });

    it('handles string with only special characters', () => {
      expect(generatePostIdFromTitle('!@#$%^&*()')).toBe('');
    });

    it('handles numeric titles', () => {
      expect(generatePostIdFromTitle('2024 Year in Review')).toBe('2024-year-in-review');
    });

    it('handles mixed case and unicode', () => {
      expect(generatePostIdFromTitle('Caf\u00e9 Life')).toBe('caf-life');
    });
  });

  describe('uploadBlogImage', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('throws for invalid file types before touching the network', async () => {
      const invalidFile = new File(['test'], 'test.txt', { type: 'text/plain' });

      await expect(uploadBlogImage(invalidFile)).rejects.toThrow(
        'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'
      );
      expect(api.post).not.toHaveBeenCalled();
    });

    it('requests the presign server-side (never the blog key) with the file metadata', async () => {
      const file = new File(['test-content'], 'test-image.jpg', { type: 'image/jpeg' });
      vi.mocked(api.post).mockResolvedValueOnce({
        data: { uploadUrl: 'https://s3.example.com/upload', imageUrl: 'https://blog/x.jpg', key: 'images/x.jpg' },
      } as never);
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true }) as never;

      await uploadBlogImage(file, 'my-post');

      expect(api.post).toHaveBeenCalledWith('/api/blog/presign-image-upload', {
        fileName: 'test-image.jpg',
        fileSize: 12, // 'test-content'.length
        mimeType: 'image/jpeg',
        postId: 'my-post',
      });
    });

    it('throws when the presign response is missing required fields', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      vi.mocked(api.post).mockResolvedValueOnce({ data: { key: 'only-a-key' } } as never);

      await expect(uploadBlogImage(file)).rejects.toThrow(
        'Invalid presigned URL response: missing uploadUrl or imageUrl'
      );
    });

    it('PUTs the bytes to the presigned S3 URL and returns url + key', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const uploadUrl = 'https://s3.example.com/upload?signature=abc';
      const imageUrl = 'https://blog.example.com/images/test.jpg';
      vi.mocked(api.post).mockResolvedValueOnce({
        data: { uploadUrl, imageUrl, key: 'images/test.jpg' },
      } as never);
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
      global.fetch = fetchMock as never;

      const result = await uploadBlogImage(file);

      expect(fetchMock).toHaveBeenCalledWith(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: file,
      });
      expect(result).toEqual({ url: imageUrl, key: 'images/test.jpg' });
    });

    it('falls back to the file name when the presign omits a key', async () => {
      const file = new File(['test'], 'photo.png', { type: 'image/png' });
      vi.mocked(api.post).mockResolvedValueOnce({
        data: { uploadUrl: 'https://s3/u', imageUrl: 'https://blog/p.png' },
      } as never);
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true }) as never;

      const result = await uploadBlogImage(file);

      expect(result.key).toBe('photo.png');
    });

    it('throws when the S3 upload fails', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      vi.mocked(api.post).mockResolvedValueOnce({
        data: { uploadUrl: 'https://s3/u', imageUrl: 'https://blog/x.jpg' },
      } as never);
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }) as never;

      await expect(uploadBlogImage(file)).rejects.toThrow('S3 upload failed with status 403');
    });
  });

  describe('getBlogUploadErrorMessage', () => {
    it('reads the server error envelope out of an AxiosError, not the generic axios message', () => {
      const err = axiosErrorWith({ error: 'File exceeds the 5MB blog limit' });

      expect(getBlogUploadErrorMessage(err, 'fallback')).toBe('File exceeds the 5MB blog limit');
    });

    it('falls back to the envelope message field when there is no error field', () => {
      const err = axiosErrorWith({ message: 'Unsupported blog host' });

      expect(getBlogUploadErrorMessage(err, 'fallback')).toBe('Unsupported blog host');
    });

    it('falls through to the axios message when the AxiosError carries no server text', () => {
      // No server envelope: the axios branch finds nothing, so the generic axios message
      // wins over the fallback (an AxiosError is still an Error). Only a non-Error hits the fallback.
      const err = axiosErrorWith({});

      expect(getBlogUploadErrorMessage(err, 'default message')).toBe('Request failed with status code 400');
    });

    it('treats an empty envelope error field as absent and falls through to the axios message', () => {
      // The `&& data.error` guard exists so an empty string does not win over the real message.
      const err = axiosErrorWith({ error: '' });

      expect(getBlogUploadErrorMessage(err, 'default message')).toBe('Request failed with status code 400');
    });

    it('falls through to the axios message when the AxiosError has no response at all', () => {
      // A network-level failure has no `response`, so the envelope read is skipped entirely.
      const err = new AxiosError('Network Error', 'ERR_NETWORK');

      expect(getBlogUploadErrorMessage(err, 'fallback')).toBe('Network Error');
    });

    it('uses a plain Error message when the failure is not an AxiosError', () => {
      expect(getBlogUploadErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
    });

    it('returns the fallback for a non-Error value', () => {
      expect(getBlogUploadErrorMessage('nope', 'fallback')).toBe('fallback');
    });
  });
});
