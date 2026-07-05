import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadBlogImage, generatePostIdFromTitle } from '../blogImageUpload';

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
    const mockBlogApiKey = 'test-api-key-123';
    // Per-user blog host passed by callers (from blogIntegration.baseUrl).
    const mockBaseUrl = 'https://blog.example.com';
    const originalFetch = global.fetch;
    const originalBlogHost = process.env.NEXT_PUBLIC_BLOG_HOST;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      global.fetch = originalFetch;
      if (originalBlogHost === undefined) delete process.env.NEXT_PUBLIC_BLOG_HOST;
      else process.env.NEXT_PUBLIC_BLOG_HOST = originalBlogHost;
    });

    it('throws error for invalid file types', async () => {
      const invalidFile = new File(['test'], 'test.txt', { type: 'text/plain' });

      await expect(uploadBlogImage(invalidFile, mockBlogApiKey, undefined, mockBaseUrl)).rejects.toThrow(
        'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'
      );
    });

    it('throws when no blog host is configured (no baseUrl, no NEXT_PUBLIC_BLOG_HOST)', async () => {
      delete process.env.NEXT_PUBLIC_BLOG_HOST;
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      await expect(uploadBlogImage(file, mockBlogApiKey)).rejects.toThrow('No blog host configured');
    });

    it('falls back to NEXT_PUBLIC_BLOG_HOST when no baseUrl is passed', async () => {
      process.env.NEXT_PUBLIC_BLOG_HOST = 'https://operator.example';
      const file = new File(['test-content'], 'test-image.jpg', { type: 'image/jpeg' });

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ uploadUrl: 'https://s3.example.com/upload', imageUrl: 'https://x/y.jpg' }),
        })
        .mockResolvedValueOnce({ ok: true });

      await uploadBlogImage(file, mockBlogApiKey);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://operator.example/api/posts/images/presigned-url',
        expect.anything()
      );
    });

    it('accepts valid image types', async () => {
      const validTypes = [
        { type: 'image/jpeg', name: 'test.jpg' },
        { type: 'image/png', name: 'test.png' },
        { type: 'image/gif', name: 'test.gif' },
        { type: 'image/webp', name: 'test.webp' },
      ];

      for (const { type, name } of validTypes) {
        const file = new File(['test'], name, { type });

        // Mock fetch to test that it gets past file validation
        global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

        // Should not throw file type error, will throw network error instead
        await expect(uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl)).rejects.toThrow('Network error');
      }
    });

    it('calls presigned URL endpoint on the passed baseUrl with correct parameters', async () => {
      const file = new File(['test-content'], 'test-image.jpg', { type: 'image/jpeg' });
      const postId = 'my-blog-post';

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            uploadUrl: 'https://s3.example.com/upload',
            imageUrl: 'https://blog.example.com/images/test.jpg',
            key: 'images/test.jpg',
          }),
      });

      // Mock the S3 upload
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
      });

      await uploadBlogImage(file, mockBlogApiKey, postId, mockBaseUrl);

      // Verify first call (presigned URL request) targets the passed baseUrl
      expect(global.fetch).toHaveBeenCalledWith('https://blog.example.com/api/posts/images/presigned-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': mockBlogApiKey,
        },
        body: JSON.stringify({
          fileName: 'test-image.jpg',
          fileSize: 12, // 'test-content'.length
          mimeType: 'image/jpeg',
          postId: postId,
        }),
      });
    });

    it('strips a trailing slash from the baseUrl', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ uploadUrl: 'https://s3.example.com/upload', imageUrl: 'https://x/y.jpg' }),
        })
        .mockResolvedValueOnce({ ok: true });

      await uploadBlogImage(file, mockBlogApiKey, undefined, 'https://blog.example.com/');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://blog.example.com/api/posts/images/presigned-url',
        expect.anything()
      );
    });

    it('throws error when presigned URL request fails', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ message: 'Unauthorized' }),
      });

      await expect(uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl)).rejects.toThrow('Unauthorized');
    });

    it('throws error when presigned URL response is missing required fields', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ someOtherField: 'value' }),
      });

      await expect(uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl)).rejects.toThrow(
        'Invalid presigned URL response: missing uploadUrl or imageUrl'
      );
    });

    it('uploads file to S3 using presigned URL', async () => {
      const file = new File(['test-content'], 'test.jpg', { type: 'image/jpeg' });
      const uploadUrl = 'https://s3.example.com/upload?signature=abc';
      const imageUrl = 'https://blog.example.com/images/test.jpg';

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              uploadUrl,
              imageUrl,
              key: 'images/test.jpg',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      await uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl);

      // Verify S3 upload call
      expect(global.fetch).toHaveBeenCalledWith(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
        },
        body: file,
      });
    });

    it('throws error when S3 upload fails', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              uploadUrl: 'https://s3.example.com/upload',
              imageUrl: 'https://blog.example.com/images/test.jpg',
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
        });

      await expect(uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl)).rejects.toThrow(
        'S3 upload failed with status 403'
      );
    });

    it('returns correct result on successful upload', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const imageUrl = 'https://blog.example.com/images/test.jpg';
      const key = 'images/test.jpg';

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              uploadUrl: 'https://s3.example.com/upload',
              imageUrl,
              key,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      const result = await uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl);

      expect(result).toEqual({
        url: imageUrl,
        key: key,
      });
    });

    it('handles alternative field names in presigned response', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const imageUrl = 'https://blog.example.com/images/test.jpg';

      // Use alternative field names
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              presignedUrl: 'https://s3.example.com/upload', // Alternative to uploadUrl
              publicUrl: imageUrl, // Alternative to imageUrl
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      const result = await uploadBlogImage(file, mockBlogApiKey, undefined, mockBaseUrl);

      expect(result.url).toBe(imageUrl);
    });
  });
});
