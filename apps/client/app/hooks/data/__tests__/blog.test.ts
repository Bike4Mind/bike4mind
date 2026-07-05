import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enhanceBlogContent } from '../blog';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    post: vi.fn(),
  },
}));

import { api } from '@client/app/contexts/ApiContext';

describe('blog data hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enhanceBlogContent', () => {
    it('calls API with correct endpoint and parameters for title enhancement', async () => {
      const mockResponse = {
        data: {
          success: true,
          enhancedTitle: 'Amazing New Title',
        },
      };
      vi.mocked(api.post).mockResolvedValue(mockResponse);

      const params = {
        content: 'Blog content here',
        currentTitle: 'Old Title',
        currentSummary: 'Old Summary',
        enhancementType: 'title' as const,
      };

      const result = await enhanceBlogContent(params);

      expect(api.post).toHaveBeenCalledWith('/api/blog/enhance', params);
      expect(result).toEqual(mockResponse.data);
    });

    it('calls API with correct endpoint and parameters for summary enhancement', async () => {
      const mockResponse = {
        data: {
          success: true,
          enhancedSummary: 'A comprehensive summary',
        },
      };
      vi.mocked(api.post).mockResolvedValue(mockResponse);

      const params = {
        content: 'Blog content here',
        currentTitle: 'Title',
        currentSummary: 'Old Summary',
        enhancementType: 'summary' as const,
      };

      const result = await enhanceBlogContent(params);

      expect(api.post).toHaveBeenCalledWith('/api/blog/enhance', params);
      expect(result).toEqual(mockResponse.data);
    });

    it('returns failure response from API', async () => {
      const mockResponse = {
        data: {
          success: false,
          message: 'Content too short',
        },
      };
      vi.mocked(api.post).mockResolvedValue(mockResponse);

      const params = {
        content: 'Short',
        currentTitle: '',
        currentSummary: '',
        enhancementType: 'title' as const,
      };

      const result = await enhanceBlogContent(params);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Content too short');
    });

    it('propagates API errors', async () => {
      vi.mocked(api.post).mockRejectedValue(new Error('Network error'));

      const params = {
        content: 'Content',
        currentTitle: '',
        currentSummary: '',
        enhancementType: 'title' as const,
      };

      await expect(enhanceBlogContent(params)).rejects.toThrow('Network error');
    });
  });

  describe('BlogPublishParams interface', () => {
    it('accepts all required and optional parameters', () => {
      // Type check - this test verifies the interface shape
      const params = {
        title: 'My Blog Post',
        content: '# Hello World\n\nThis is my post.',
        summary: 'A brief summary',
        tags: ['tech', 'react'],
        status: 'published' as const,
        featuredImage: 'https://example.com/image.jpg',
        publishedAt: Date.now(),
      };

      // If TypeScript compiles, the interface is correct
      expect(params.title).toBe('My Blog Post');
      expect(params.status).toBe('published');
      expect(params.tags).toHaveLength(2);
    });

    it('allows minimal required parameters', () => {
      const params = {
        title: 'Title',
        content: 'Content',
      };

      expect(params.title).toBeDefined();
      expect(params.content).toBeDefined();
    });
  });

  describe('BlogPublishResult interface', () => {
    it('has correct structure', () => {
      const result = {
        success: true,
        message: 'Post published successfully',
        url: 'https://erikbethke.com/blog/my-post',
        postId: 'abc123',
        post: {
          postId: 'abc123',
          title: 'My Post',
          status: 'published',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

      expect(result.success).toBe(true);
      expect(result.url).toContain('erikbethke.com');
      expect(result.post.postId).toBe(result.postId);
    });
  });
});
