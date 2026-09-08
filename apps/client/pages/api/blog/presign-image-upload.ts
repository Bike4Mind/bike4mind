import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/utils';
import { decryptToken } from '@server/security/tokenEncryption';

interface PresignImageUploadRequest {
  fileName: string;
  fileSize: number;
  mimeType: string;
  postId?: string;
}

interface PresignImageUploadResponse {
  uploadUrl: string;
  imageUrl: string;
  key?: string;
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Server-side presign for a blog image upload. The blog API key lives in
 * `user.blogIntegration` and must never reach the browser (the identify response redacts
 * it), so the presign request - the one step that carries the key - runs here instead of
 * in the client. The browser gets back only the S3 upload URL it then PUTs to. Mirrors
 * blog/publish.ts, the other server-side reader of the blog key, and takes over the host
 * selection the client util used to do so a per-user baseUrl is no longer CSP-bound.
 */
const handler = baseApi().post<Request<unknown, PresignImageUploadResponse, PresignImageUploadRequest>>(
  async (req, res) => {
    const user = req.user!;
    const { fileName, fileSize, mimeType, postId } = req.body;

    if (!fileName?.trim() || !mimeType?.trim() || typeof fileSize !== 'number') {
      throw new BadRequestError('fileName, fileSize and mimeType are required');
    }
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      throw new BadRequestError('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.');
    }
    if (!user.blogIntegration?.apiKey || !user.blogIntegration?.baseUrl) {
      throw new BadRequestError(
        'Blog integration not configured. Add your blog API key in Settings -> Integrations -> Blog Publishing.'
      );
    }

    const host = user.blogIntegration.baseUrl.replace(/\/+$/, '');
    const apiKey = decryptToken(user.blogIntegration.apiKey) ?? '';

    // Bound the outbound call to a user-controlled host so a hung blog cannot pin the
    // handler to the platform timeout (matches blog/publish.ts).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s

    let response: Response;
    try {
      response = await fetch(`${host}/api/posts/images/presigned-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ fileName, fileSize, mimeType, postId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (error) {
      clearTimeout(timeoutId);
      req.logger.error('[Blog presign] request to blog failed:', error);
      throw new BadRequestError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Blog upload URL request timed out after 15s'
          : 'Failed to reach the blog to request an upload URL'
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = `Presigned URL request failed with status ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed.message || parsed.error || message;
      } catch {
        if (text) message = text.substring(0, 200);
      }
      throw new BadRequestError(message);
    }

    const presigned = await response.json();
    const uploadUrl = presigned.uploadUrl || presigned.presignedUrl || presigned.url;
    const imageUrl = presigned.imageUrl || presigned.publicUrl;
    if (!uploadUrl || !imageUrl) {
      throw new BadRequestError('Invalid presigned URL response from blog: missing uploadUrl or imageUrl');
    }

    res.json({ uploadUrl, imageUrl, key: presigned.key });
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
