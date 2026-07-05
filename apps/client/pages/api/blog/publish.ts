import { baseApi } from '@server/middlewares/baseApi';
import { IUserDocument } from '@bike4mind/common';
import { decryptToken } from '@server/security/tokenEncryption';

interface BlogPublishParams {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  status?: 'draft' | 'published';
  featuredImage?: string;
  publishedAt?: number; // Unix timestamp in milliseconds
}

interface BlogPublishResponse {
  post: {
    postId: string;
    title: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  };
}

async function publishToBlog(user: IUserDocument, params: BlogPublishParams): Promise<BlogPublishResponse> {
  if (!user?.blogIntegration) {
    throw new Error(
      'Blog integration not configured. Please add your blog API key in Settings → Integrations → Blog Publishing.'
    );
  }

  const { apiKey: rawApiKey, baseUrl, defaultAuthor, defaultTags } = user.blogIntegration;
  const apiKey = decryptToken(rawApiKey) ?? '';

  const requestBody: Record<string, any> = {
    title: params.title,
    content: params.content,
    summary: params.summary,
    tags: params.tags || defaultTags || [],
    status: params.status || 'published',
    author: defaultAuthor || user.name || 'Unknown',
  };

  if (params.featuredImage) {
    requestBody.featuredImage = params.featuredImage;
  }
  if (params.publishedAt !== undefined) {
    requestBody.publishedAt = params.publishedAt;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for blog publishing

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      throw new Error('Blog API request timed out after 15s');
    }
    throw fetchError;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to publish blog post: ${response.status} ${response.statusText}. ${errorText}`);
  }

  const data: BlogPublishResponse = await response.json();
  return data;
}

const handler = baseApi().post(async (req, res) => {
  try {
    const params = req.body as BlogPublishParams;
    const result = await publishToBlog(req.user, params);

    const baseUrl = req.user.blogIntegration?.baseUrl || '';
    const publishedUrl = `${baseUrl}/blog/post/${result.post.postId}`;
    const statusText = params.status === 'draft' ? 'saved as draft' : 'published';

    return res.json({
      success: true,
      message: `Blog post "${params.title}" ${statusText} successfully!`,
      url: publishedUrl,
      postId: result.post.postId,
      post: result.post,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to publish blog post';
    const isConfigError = message.includes('not configured');
    if (isConfigError) {
      console.warn('Blog publish config issue:', message);
      return res.status(422).json({ success: false, message });
    }
    console.error('Blog publish error:', error);
    return res.status(500).json({ success: false, message });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
