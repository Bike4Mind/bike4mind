import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface BlogPublishParams {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  status?: 'draft' | 'published';
  featuredImage?: string;
  publishedAt?: number; // Unix timestamp in milliseconds
}

export interface BlogPublishResult {
  success: boolean;
  message: string;
  url: string;
  postId: string;
  post: {
    postId: string;
    title: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  };
}

export interface BlogEnhanceParams {
  content: string;
  currentTitle: string;
  currentSummary: string;
  enhancementType: 'title' | 'summary';
}

export interface BlogEnhanceResult {
  success: boolean;
  message?: string;
  enhancedTitle?: string;
  enhancedSummary?: string;
}

export async function enhanceBlogContent(params: BlogEnhanceParams): Promise<BlogEnhanceResult> {
  const response = await api.post('/api/blog/enhance', params);
  return response.data;
}

export function usePublishBlog({
  onSuccess,
  onError,
}: { onSuccess?: (data: BlogPublishResult) => void; onError?: (error: Error) => void } = {}) {
  return useMutation<BlogPublishResult, Error, BlogPublishParams>({
    mutationFn: async params => {
      const response = await api.post('/api/blog/publish', params);
      return response.data;
    },
    onSuccess: data => {
      if (onSuccess) onSuccess(data);
    },
    onError: error => {
      if (onError) onError(error);
    },
  });
}
