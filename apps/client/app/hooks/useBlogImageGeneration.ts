import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { uploadBlogImage, generatePostIdFromTitle } from '@client/app/utils/blogImageUpload';
import { useLLM } from '@client/app/contexts/LLMContext';

interface UseBlogImageGenerationProps {
  content: string;
  title: string;
  summary: string;
  blogApiKey: string;
  /** Blog host from blogIntegration.baseUrl; falls back to the operator default. */
  blogBaseUrl?: string;
  onImageGenerated?: (imageUrl: string, prompt: string) => void;
}

interface GenerateImagePromptResponse {
  success: boolean;
  prompt: string;
  message?: string;
}

interface GenerateFeaturedImageResponse {
  success: boolean;
  imageUrl: string;
  message?: string;
}

export const useBlogImageGeneration = ({
  content,
  title,
  summary,
  blogApiKey,
  blogBaseUrl,
  onImageGenerated,
}: UseBlogImageGenerationProps) => {
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);

  // User's preferred image model from the LLM store (last selected in advanced settings).
  const imageModel = useLLM(state => state.imageModel);

  const generateFeaturedImage = useCallback(async () => {
    if (!content.trim()) {
      toast.error('Please provide content first');
      return;
    }

    setIsGeneratingImage(true);

    try {
      toast.info('🎨 Generating featured image from content... This may take a moment! ⏳');

      // Step 1: Generate image prompt from blog content
      const promptResponse = await api.post<GenerateImagePromptResponse>('/api/blog/generate-image-prompt', {
        content,
        title,
        summary,
      });

      if (!promptResponse.data.success || !promptResponse.data.prompt) {
        throw new Error(promptResponse.data.message || 'Failed to generate image prompt');
      }

      const imagePrompt = promptResponse.data.prompt;

      // Step 2: Generate image using dedicated blog image endpoint
      // This endpoint waits for the image to be generated (synchronous)
      // rather than queueing like /api/ai/generate-image
      const imageResponse = await api.post<GenerateFeaturedImageResponse>('/api/blog/generate-featured-image', {
        imagePrompt,
        imageModel, // Use user's preferred image model from LLM settings
      });

      if (!imageResponse.data.success || !imageResponse.data.imageUrl) {
        throw new Error(imageResponse.data.message || 'Failed to generate image');
      }

      const imageUrl = imageResponse.data.imageUrl;

      // Step 3: Convert base64 to blob and upload to blog S3
      toast.info('📤 Uploading to blog...');

      // The image URL is now a base64 data URL from the server
      // Convert it to a blob for upload
      let blob: Blob;
      if (imageUrl.startsWith('data:')) {
        // Parse base64 data URL
        const [header, base64Data] = imageUrl.split(',');
        const mimeMatch = header.match(/data:([^;]+)/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: mimeType });
      } else {
        // Fallback for regular URLs (shouldn't happen with new endpoint)
        blob = await fetch(imageUrl).then(r => r.blob());
      }

      const file = new File([blob], 'featured-image.png', { type: blob.type || 'image/png' });

      const postId = title ? generatePostIdFromTitle(title) : 'featured';
      const uploadResult = await uploadBlogImage(file, blogApiKey, postId, blogBaseUrl);

      if (onImageGenerated) {
        onImageGenerated(uploadResult.url, imagePrompt);
      }

      toast.success('🔥 Featured image generated and uploaded! ✨');

      return {
        imageUrl: uploadResult.url,
        prompt: imagePrompt,
      };
    } catch (error) {
      let errorMessage = 'Failed to generate image. Please try again.';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error && typeof error === 'object' && 'response' in error) {
        const response = (error as any).response;
        if (response?.data?.message) {
          errorMessage = response.data.message;
        } else if (response?.data?.error) {
          errorMessage = response.data.error;
        }
      }

      toast.error(errorMessage);
      throw error;
    } finally {
      setIsGeneratingImage(false);
    }
  }, [content, title, summary, blogApiKey, blogBaseUrl, onImageGenerated, imageModel]);

  return {
    generateFeaturedImage,
    isGeneratingImage,
  };
};
