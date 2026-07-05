import { getBlogHost } from './blogConfig';

export interface BlogImageUploadResult {
  url: string;
  key: string;
}

/**
 * Upload an image to the configured blog's S3 bucket using the presigned URL workflow.
 * @param file - The image file to upload
 * @param blogApiKey - User's blog API key from blogIntegration.apiKey
 * @param postId - Optional post ID to organize images by post
 * @param baseUrl - Blog host to target (from blogIntegration.baseUrl). Falls back to the
 *   operator default (NEXT_PUBLIC_BLOG_HOST); empty for an unbranded fork.
 * @returns Upload result with URL
 */
export async function uploadBlogImage(
  file: File,
  blogApiKey: string,
  postId?: string,
  baseUrl?: string
): Promise<BlogImageUploadResult> {
  // File type validation
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.');
  }

  // The upload targets the user's saved blog host (`baseUrl`, from
  // blogIntegration.baseUrl) and falls back to the operator default
  // (`getBlogHost()` <- NEXT_PUBLIC_BLOG_HOST). Supported-host contract: the proxy
  // CSP `connect-src`/`img-src` allow-lists the operator default host only, so a
  // user-configured `baseUrl` that diverges from NEXT_PUBLIC_BLOG_HOST will have
  // this presign POST blocked by CSP. The operator-default host is the supported
  // blog-integration target; custom per-user hosts require adding them to the CSP
  // (per-response override), a known limitation.
  const host = (baseUrl || getBlogHost()).replace(/\/+$/, '');
  if (!host) {
    throw new Error('No blog host configured. Set your blog URL in Settings → Blog Integration.');
  }

  // Step 1: Request presigned URL from blog API
  const presignedResponse = await fetch(`${host}/api/posts/images/presigned-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': blogApiKey,
    },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      postId: postId,
    }),
  });

  if (!presignedResponse.ok) {
    // Try to get error details from response
    let errorData: any = {};
    const contentType = presignedResponse.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      errorData = await presignedResponse.json().catch(() => ({}));
    } else {
      // Response might be text/html or other format
      const text = await presignedResponse.text().catch(() => '');
      errorData = { error: text.substring(0, 200) };
    }

    throw new Error(
      errorData.message || errorData.error || `Presigned URL request failed with status ${presignedResponse.status}`
    );
  }

  const presignedData = await presignedResponse.json();

  // The upload URL might be under different field names
  const uploadUrl = presignedData.uploadUrl || presignedData.presignedUrl || presignedData.url;
  const imageUrl = presignedData.imageUrl || presignedData.publicUrl;

  if (!uploadUrl || !imageUrl) {
    throw new Error('Invalid presigned URL response: missing uploadUrl or imageUrl');
  }

  // Step 2: Upload directly to S3 using presigned URL

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type,
    },
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error(`S3 upload failed with status ${uploadResponse.status}`);
  }

  return {
    url: imageUrl,
    key: presignedData.key || file.name,
  };
}

/**
 * Generate a sanitized post ID from the blog post title
 * @param title - Blog post title
 * @returns Sanitized post ID safe for URLs and file paths
 */
export function generatePostIdFromTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}
