import { z } from 'zod';

/**
 * Wire contract between the publish-thumbnail orchestrator (queueHandlers/publishThumbnail.ts) and
 * the renderer function (media/publishThumbnailRenderer.ts). Imported by the renderer, so it must
 * stay free of application config: zod only (publishThumbnailRenderer.isolation.test.ts).
 *
 * The document travels by URL, not inline: a fully inlined bundle can exceed the 6 MB synchronous
 * invoke payload. The image comes back inline: a 640x400 WebP is far below that limit.
 */

/** Largest document the renderer will fetch (bytes): a 10 MB index.html plus ~8 MB of inlined assets fits. */
export const MAX_THUMBNAIL_DOCUMENT_BYTES = 32 * 1024 * 1024;
/** Largest image either side accepts (bytes); a 640x400 WebP is tens of KB. */
export const MAX_THUMBNAIL_IMAGE_BYTES = 2 * 1024 * 1024;

export const ThumbnailRenderRequestSchema = z.object({
  /** Short-lived presigned GET of the staged document; the renderer holds no credentials of its own. */
  documentUrl: z.url({ protocol: /^https$/ }),
  /** Exact script URLs the page may load (see renderHtmlThumbnail). */
  allowedScriptUrls: z.array(z.url({ protocol: /^https?$/ })).max(64),
});
export type ThumbnailRenderRequest = z.infer<typeof ThumbnailRenderRequestSchema>;

export const ThumbnailRenderResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('rendered'),
    imageBase64: z
      .base64()
      .min(1)
      .max(Math.ceil(MAX_THUMBNAIL_IMAGE_BYTES / 3) * 4),
  }),
  // The page wedged the browser past the hard deadline; permanent for that version.
  z.object({ status: z.literal('timed-out') }),
]);
export type ThumbnailRenderResponse = z.infer<typeof ThumbnailRenderResponseSchema>;

/** RIFF container with a WEBP form type: the only bytes the orchestrator will store as a thumbnail. */
export function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
}
