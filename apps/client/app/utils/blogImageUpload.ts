import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';

export interface BlogImageUploadResult {
  url: string;
  key: string;
}

interface PresignImageUploadResponse {
  uploadUrl: string;
  imageUrl: string;
  key?: string;
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Upload an image to the user's configured blog via the presigned-URL workflow.
 *
 * The presign request carries the blog API key, so it runs SERVER-SIDE:
 * `/api/blog/presign-image-upload` reads `user.blogIntegration` and holds the key. The
 * browser never receives it (the identify response redacts it). Only the second step -
 * the keyless PUT to the returned S3 URL - stays in the browser. Host selection and the
 * CSP allow-list also move server-side with the presign.
 *
 * @param file - The image file to upload.
 * @param postId - Optional post ID to organize images by post.
 */
export async function uploadBlogImage(file: File, postId?: string): Promise<BlogImageUploadResult> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.');
  }

  // Step 1: the server mints a presigned upload URL using the blog key it holds.
  const { data } = await api.post<PresignImageUploadResponse>('/api/blog/presign-image-upload', {
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    postId,
  });

  if (!data.uploadUrl || !data.imageUrl) {
    throw new Error('Invalid presigned URL response: missing uploadUrl or imageUrl');
  }

  // Step 2: upload the bytes directly to S3 with the presigned URL (no key needed).
  const uploadResponse = await fetch(data.uploadUrl, {
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
    url: data.imageUrl,
    key: data.key || file.name,
  };
}

/**
 * Pull a human-readable message out of an upload failure. The presign step goes through
 * axios, whose interceptor rethrows the AxiosError untouched, so `error.message` is the
 * generic "Request failed with status code 400" - the real reason lives in the server's
 * `{ error }` envelope. Read that first, then fall back to a plain Error's message, then
 * the caller's default. Callers must NOT use `error instanceof Error` first: an AxiosError
 * IS an Error, so that branch would swallow the server text.
 */
export function getBlogUploadErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as { error?: string; message?: string } | undefined;
    if (typeof data?.error === 'string' && data.error) return data.error;
    if (typeof data?.message === 'string' && data.message) return data.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
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
