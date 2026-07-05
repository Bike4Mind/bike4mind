import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlogImageGeneration } from '../useBlogImageGeneration';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    post: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@client/app/utils/blogImageUpload', () => ({
  uploadBlogImage: vi.fn(),
  generatePostIdFromTitle: vi.fn((title: string) => title.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: vi.fn(() => 'flux-pro-1.1'),
}));

import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { uploadBlogImage } from '@client/app/utils/blogImageUpload';

describe('useBlogImageGeneration', () => {
  const mockContent = 'This is a blog post about React hooks and testing.';
  const mockTitle = 'React Hooks Guide';
  const mockSummary = 'A comprehensive guide to React hooks';
  const mockBlogApiKey = 'test-api-key';
  const mockOnImageGenerated = vi.fn();

  // Sample base64 PNG (1x1 transparent pixel)
  const sampleBase64 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns correct initial state', () => {
      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      expect(result.current.isGeneratingImage).toBe(false);
      expect(typeof result.current.generateFeaturedImage).toBe('function');
    });
  });

  describe('generateFeaturedImage', () => {
    it('shows error toast when content is empty', async () => {
      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: '',
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(toast.error).toHaveBeenCalledWith('Please provide content first');
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows error toast when content is whitespace only', async () => {
      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: '   ',
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(toast.error).toHaveBeenCalledWith('Please provide content first');
    });

    it('calls generate-image-prompt API with correct parameters', async () => {
      vi.mocked(api.post)
        .mockResolvedValueOnce({
          data: { success: true, prompt: 'A beautiful illustration of React hooks' },
        })
        .mockResolvedValueOnce({
          data: { success: true, imageUrl: sampleBase64 },
        });

      vi.mocked(uploadBlogImage).mockResolvedValue({
        url: 'https://blog.example.com/images/featured.png',
        key: 'images/featured.png',
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(api.post).toHaveBeenCalledWith('/api/blog/generate-image-prompt', {
        content: mockContent,
        title: mockTitle,
        summary: mockSummary,
      });
    });

    it('calls generate-featured-image API with prompt and image model', async () => {
      vi.mocked(api.post)
        .mockResolvedValueOnce({
          data: { success: true, prompt: 'A beautiful illustration' },
        })
        .mockResolvedValueOnce({
          data: { success: true, imageUrl: sampleBase64 },
        });

      vi.mocked(uploadBlogImage).mockResolvedValue({
        url: 'https://blog.example.com/images/featured.png',
        key: 'images/featured.png',
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(api.post).toHaveBeenCalledWith('/api/blog/generate-featured-image', {
        imagePrompt: 'A beautiful illustration',
        imageModel: 'flux-pro-1.1',
      });
    });

    it('uploads image to blog and calls onImageGenerated callback', async () => {
      const generatedPrompt = 'A stunning React hooks visualization';
      const uploadedUrl = 'https://blog.example.com/images/react-hooks-guide.png';

      vi.mocked(api.post)
        .mockResolvedValueOnce({
          data: { success: true, prompt: generatedPrompt },
        })
        .mockResolvedValueOnce({
          data: { success: true, imageUrl: sampleBase64 },
        });

      vi.mocked(uploadBlogImage).mockResolvedValue({
        url: uploadedUrl,
        key: 'images/react-hooks-guide.png',
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(uploadBlogImage).toHaveBeenCalledWith(expect.any(File), mockBlogApiKey, 'react-hooks-guide', undefined);
      expect(mockOnImageGenerated).toHaveBeenCalledWith(uploadedUrl, generatedPrompt);
      expect(toast.success).toHaveBeenCalled();
    });

    it('forwards the configured blogBaseUrl to uploadBlogImage', async () => {
      const generatedPrompt = 'A stunning React hooks visualization';
      const uploadedUrl = 'https://blog.example.com/images/react-hooks-guide.png';
      vi.mocked(api.post)
        .mockResolvedValueOnce({ data: { success: true, prompt: generatedPrompt } })
        .mockResolvedValueOnce({ data: { success: true, imageUrl: sampleBase64 } });

      vi.mocked(uploadBlogImage).mockResolvedValue({
        url: uploadedUrl,
        key: 'images/react-hooks-guide.png',
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          blogBaseUrl: 'https://blog.example.com',
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(uploadBlogImage).toHaveBeenCalledWith(
        expect.any(File),
        mockBlogApiKey,
        'react-hooks-guide',
        'https://blog.example.com'
      );
    });

    it('shows error when prompt generation fails', async () => {
      vi.mocked(api.post).mockResolvedValueOnce({
        data: { success: false, message: 'Content too short for image generation' },
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        try {
          await result.current.generateFeaturedImage();
        } catch {
          // Expected to throw
        }
      });

      expect(toast.error).toHaveBeenCalledWith('Content too short for image generation');
      expect(mockOnImageGenerated).not.toHaveBeenCalled();
    });

    it('shows error when image generation fails', async () => {
      vi.mocked(api.post)
        .mockResolvedValueOnce({
          data: { success: true, prompt: 'Test prompt' },
        })
        .mockResolvedValueOnce({
          data: { success: false, message: 'Image generation service unavailable' },
        });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        try {
          await result.current.generateFeaturedImage();
        } catch {
          // Expected to throw
        }
      });

      expect(toast.error).toHaveBeenCalledWith('Image generation service unavailable');
      expect(mockOnImageGenerated).not.toHaveBeenCalled();
    });

    it('handles API network errors', async () => {
      vi.mocked(api.post).mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        try {
          await result.current.generateFeaturedImage();
        } catch {
          // Expected to throw
        }
      });

      expect(toast.error).toHaveBeenCalledWith('Network error');
    });

    it('returns generated image URL and prompt on success', async () => {
      const generatedPrompt = 'A beautiful illustration';
      const uploadedUrl = 'https://blog.example.com/images/featured.png';

      vi.mocked(api.post)
        .mockResolvedValueOnce({
          data: { success: true, prompt: generatedPrompt },
        })
        .mockResolvedValueOnce({
          data: { success: true, imageUrl: sampleBase64 },
        });

      vi.mocked(uploadBlogImage).mockResolvedValue({
        url: uploadedUrl,
        key: 'images/featured.png',
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      let returnValue: { imageUrl: string; prompt: string } | undefined;
      await act(async () => {
        returnValue = await result.current.generateFeaturedImage();
      });

      expect(returnValue).toEqual({
        imageUrl: uploadedUrl,
        prompt: generatedPrompt,
      });
    });

    it('uses "featured" as postId when title is empty', async () => {
      vi.mocked(api.post)
        .mockResolvedValueOnce({
          data: { success: true, prompt: 'Test prompt' },
        })
        .mockResolvedValueOnce({
          data: { success: true, imageUrl: sampleBase64 },
        });

      vi.mocked(uploadBlogImage).mockResolvedValue({
        url: 'https://blog.example.com/images/featured.png',
        key: 'images/featured.png',
      });

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: '', // Empty title
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      await act(async () => {
        await result.current.generateFeaturedImage();
      });

      expect(uploadBlogImage).toHaveBeenCalledWith(expect.any(File), mockBlogApiKey, 'featured', undefined);
    });
  });

  describe('loading state', () => {
    it('sets isGeneratingImage to true during generation', async () => {
      // Create a promise we can control
      let resolvePrompt: (value: any) => void;
      const promptPromise = new Promise(resolve => {
        resolvePrompt = resolve;
      });

      vi.mocked(api.post).mockReturnValueOnce(promptPromise as any);

      const { result } = renderHook(() =>
        useBlogImageGeneration({
          content: mockContent,
          title: mockTitle,
          summary: mockSummary,
          blogApiKey: mockBlogApiKey,
          onImageGenerated: mockOnImageGenerated,
        })
      );

      expect(result.current.isGeneratingImage).toBe(false);

      // Start generation and capture the promise to handle the rejection
      let generationPromise: Promise<any>;
      act(() => {
        generationPromise = result.current.generateFeaturedImage();
      });

      // Should be loading now
      expect(result.current.isGeneratingImage).toBe(true);

      // Resolve the prompt promise with a failure response
      // Then await and catch the error from generateFeaturedImage
      await act(async () => {
        resolvePrompt!({ data: { success: false, message: 'Test' } });
        // Wait for the hook to process the response and throw
        try {
          await generationPromise!;
        } catch {
          // Expected - the hook throws when success is false
        }
      });

      // Should be done loading
      expect(result.current.isGeneratingImage).toBe(false);
    });
  });
});
