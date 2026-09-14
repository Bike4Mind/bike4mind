import { baseApi } from '@server/middlewares/baseApi';
import { IUserDocument } from '@bike4mind/common';
import { decryptToken } from '@server/security/tokenEncryption';
import { assertUrlAllowed, safeFetch, SsrfError } from '@server/utils/ssrfProtection';

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

  // Fail closed against SSRF: this runs server-side with the user's blog key, so a baseUrl
  // pointed at an internal/metadata host would let the server reach it on the caller's behalf.
  // Reject the host up front (DNS-resolving, so a public name that resolves to a private IP is
  // caught too); the outbound safeFetch below re-checks it and a redirect hop. Mirrors
  // blog/presign-image-upload.ts (shared guard).
  try {
    await assertUrlAllowed(baseUrl);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw new Error(`Blog integration baseUrl is not allowed: ${e.message}`);
    }
    throw e;
  }

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
    response = await safeFetch(`${baseUrl}/api/posts`, {
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
    // Keep every baseUrl problem (including a redirect to an internal host) in the same 422
    // "not allowed" bucket the up-front guard uses.
    if (fetchError instanceof SsrfError) {
      throw new Error(`Blog integration baseUrl is not allowed: ${fetchError.message}`);
    }
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      throw new Error('Blog API request timed out after 15s');
    }
    throw fetchError;
  }

  if (!response.ok) {
    // Bound what the upstream body can leak into our response: parse a message/error field, else
    // cap the raw text. An unbounded relay of a user-supplied host's response is an SSRF read half.
    // Mirrors presign-image-upload.ts.
    const text = await response.text().catch(() => '');
    let detail = `status ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.error || detail;
    } catch {
      if (text) detail = text.substring(0, 200);
    }
    throw new Error(`Failed to publish blog post: ${detail}`);
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
    const isConfigError = message.includes('not configured') || message.startsWith('Blog integration baseUrl');
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
