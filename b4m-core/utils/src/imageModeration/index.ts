import {
  RekognitionClient,
  DetectModerationLabelsCommand,
  InvalidImageFormatException,
} from '@aws-sdk/client-rekognition';
import { Logger } from '@bike4mind/observability';

/**
 * Rekognition top-level ("L1") categories we block on. Broadening is a policy change.
 *
 * The account runs Content Moderation model v7 (3-tier taxonomy), where the explicit-content
 * top level is `Explicit` (L1), with `Explicit Nudity` demoted to an L2 under it and the
 * concrete parts (`Exposed Female Genitalia`, ...) as L3. Blocking the L1 `Explicit` (matched
 * by name OR parentName) therefore covers the WHOLE explicit subtree - Explicit Nudity,
 * Explicit Sexual Activity, and Sex Toys - not just the Explicit-Nudity branch.
 *
 * `Explicit Nudity` is kept in the set too so the gate still blocks correctly on the older v6
 * taxonomy (where `Explicit Nudity` was itself the L1). Verified against live Rekognition:
 * model v7 returns `{Name:'Explicit', ParentName:''}` (L1) and `{Name:'Explicit Nudity',
 * ParentName:'Explicit'}` (L2). We deliberately do NOT block the separate `Non-Explicit
 * Nudity of Intimate parts and Kissing` or `Swimwear or Underwear` L1 categories - that is the
 * mild content the product allows (see safety_tolerance cap).
 */
export const BLOCKED_CATEGORIES = ['Explicit', 'Explicit Nudity'] as const;

/** Confidence floor (0-100) for a block. Rekognition returns per-label confidence. */
export const EXPLICIT_NUDITY_CONFIDENCE = 90;

/**
 * Total attempts against Rekognition before failing closed. The SDK client is constructed with
 * `maxAttempts: 1` so THIS loop is the single source of retries (avoids SDK-retries x loop
 * fan-out on a persistent outage).
 */
const MAX_ATTEMPTS = 3;

/**
 * Rekognition's inline `Image.Bytes` hard limit is 5 MB. HD PNGs from FLUX Pro Ultra /
 * GPT-Image can exceed it, which would make `checkImage` fail-closed and break legitimate
 * large-image generation. Anything over this threshold is downscaled (moderation does not
 * need full resolution) before the call. Margin kept under 5 MB for request overhead.
 */
const MAX_INLINE_IMAGE_BYTES = 4.5 * 1024 * 1024;

export interface ModerationLabelHit {
  name: string;
  parentName: string;
  confidence: number;
}

export interface ImageModerationService {
  /**
   * Resolves if the image is clean; throws ImageModerationBlockedError if blocked.
   * `mimeType` is currently unused (Rekognition detects format from the bytes) - reserved
   * for a future S3Object-input path for images too large to downscale inline.
   */
  checkImage(bytes: Buffer, mimeType: string): Promise<void>;
}

export class ImageModerationBlockedError extends Error {
  readonly labels: ModerationLabelHit[];
  constructor(labels: ModerationLabelHit[]) {
    super(
      `Image blocked by content moderation: ${labels.map(l => `${l.name} (${l.confidence.toFixed(1)}%)`).join(', ')}`
    );
    this.name = 'ImageModerationBlockedError';
    this.labels = labels;
  }
}

/**
 * Thrown by `checkImage` when the image bytes are a format Rekognition's
 * `DetectModerationLabels` cannot process (`InvalidImageFormatException` - it only accepts
 * JPEG/PNG, and WEBP in some regions) AND jimp cannot decode/transcode them into something
 * it can (e.g. HEIC, SVG).
 *
 * Deliberately distinct from both `ImageModerationBlockedError` (a confirmed explicit-
 * content match, with `labels`) and a bare `Error` (a transient/retryable failure like
 * throttling): this is a deterministic, non-retryable "we structurally cannot scan this"
 * outcome. The caller (`moderateUploadedFile`) maps it to a terminal 'blocked' verdict
 * instead of rethrowing for S3 to redeliver forever - an unscannable image must fail closed
 * (not served) rather than get stuck 'pending' indefinitely.
 */
export class UnsupportedImageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageFormatError';
  }
}

export class RekognitionImageModerationService implements ImageModerationService {
  private client: RekognitionClient;
  private logger: Logger;

  constructor(logger: Logger, client?: RekognitionClient) {
    this.logger = logger;
    // Same construction posture as S3Storage: region from env, ambient IAM creds.
    // maxAttempts: 1 - retries are owned by checkImage's own loop (see MAX_ATTEMPTS).
    this.client =
      client ??
      new RekognitionClient({
        region: process.env.AWS_REGION || 'us-east-2',
        maxAttempts: 1,
      });
  }

  /**
   * Downscale buffers that exceed Rekognition's inline 5 MB limit so the check still runs.
   *
   * Split into two try/catches deliberately: a `Jimp.read()` failure means jimp
   * could not even decode the format - the SAME condition `transcodeToJpeg`'s catch below
   * treats as a confirmed unsupported format - so it's terminal via `UnsupportedImageFormatError`
   * right here. Without this, an oversized+undecodable buffer (e.g. HEIC from an iPhone, which
   * is both large and a format jimp can't read) would fall through with the ORIGINAL oversized
   * bytes; Rekognition would then likely throw `ImageTooLargeException` rather than
   * `InvalidImageFormatException` (it never gets far enough to inspect the format), which isn't
   * caught by the reactive transcode branch in `checkImage` - so it would burn the
   * transient-retry budget and get stuck 'pending' until DLQ instead of terminating cleanly.
   * `Jimp.read()` is a synchronous local decode with no I/O, so unlike the Rekognition call
   * there is no throttling/5xx-style transient failure mode to preserve here - any read failure
   * is safely treated as terminal.
   *
   * A failure in the SECOND try (resize/re-encode, after a successful decode) is NOT a format
   * problem - jimp already proved it can read these bytes - so that one keeps the original
   * fall-through-with-original-bytes behavior: the Rekognition call will fail-closed (block)
   * rather than silently skip, which is the safe direction.
   */
  private async fitForInlineDetection(bytes: Buffer): Promise<Buffer> {
    if (bytes.length <= MAX_INLINE_IMAGE_BYTES) return bytes;
    // Dynamic import mirrors ensureImageWithinDimensionLimit in llm/utils.ts: a static jimp
    // import makes bundlers (CLI's tsdown) treat it as external even where it's never called.
    const { Jimp } = await import('jimp');
    let image: Awaited<ReturnType<typeof Jimp.read>>;
    try {
      image = await Jimp.read(bytes);
    } catch (err) {
      this.logger.warn(
        `[ImageModeration] oversized image (${bytes.length}B) could not be decoded for downscaling, unsupported format: ${(err as Error).message}`
      );
      throw new UnsupportedImageFormatError(
        `Oversized image (${bytes.length}B) could not be decoded for downscaling: ${(err as Error).message}`
      );
    }
    try {
      const { width, height } = image.bitmap;
      const scale = 2048 / Math.max(width, height);
      // Re-encode as JPEG - smaller than PNG for photographic content, reliably under the cap.
      const resized = Buffer.from(
        await image.resize({ w: Math.floor(width * scale), h: Math.floor(height * scale) }).getBuffer('image/jpeg')
      );
      this.logger.warn(
        `[ImageModeration] image ${bytes.length}B exceeded inline limit; downscaled to ${resized.length}B for moderation`
      );
      return resized;
    } catch (err) {
      // If downscaling fails, fall through with the original - the Rekognition call will
      // then fail-closed (block) rather than silently skip, which is the safe direction.
      this.logger.warn(`[ImageModeration] downscale failed: ${(err as Error).message}`);
      return bytes;
    }
  }

  /**
   * Re-encode arbitrary jimp-decodable bytes as JPEG. Used reactively when
   * Rekognition rejects the original format - jimp decodes jpeg/png/webp/gif/bmp/tiff, a
   * broader set than Rekognition itself accepts (jpeg/png, webp in some regions), so this
   * recovers formats Rekognition can't parse but jimp can. If jimp ALSO can't decode the
   * bytes (e.g. HEIC, SVG), it throws and the caller treats that as a confirmed unsupported
   * format rather than a transient failure.
   */
  private async transcodeToJpeg(bytes: Buffer): Promise<Buffer> {
    // Dynamic import for the same bundler reason as fitForInlineDetection.
    const { Jimp } = await import('jimp');
    const image = await Jimp.read(bytes);
    return Buffer.from(await image.getBuffer('image/jpeg'));
  }

  async checkImage(bytes: Buffer, _mimeType: string): Promise<void> {
    let image = await this.fitForInlineDetection(bytes);
    let triedTranscode = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.client.send(
          new DetectModerationLabelsCommand({
            Image: { Bytes: image },
            MinConfidence: EXPLICIT_NUDITY_CONFIDENCE,
          })
        );
        const hits: ModerationLabelHit[] = (res.ModerationLabels ?? [])
          .map(l => ({
            name: l.Name ?? '',
            parentName: l.ParentName ?? '',
            confidence: l.Confidence ?? 0,
          }))
          .filter(
            l =>
              (BLOCKED_CATEGORIES.includes(l.name as (typeof BLOCKED_CATEGORIES)[number]) ||
                BLOCKED_CATEGORIES.includes(l.parentName as (typeof BLOCKED_CATEGORIES)[number])) &&
              l.confidence >= EXPLICIT_NUDITY_CONFIDENCE
          );
        if (hits.length > 0) {
          throw new ImageModerationBlockedError(hits);
        }
        return; // clean
      } catch (err) {
        if (err instanceof ImageModerationBlockedError) throw err; // a block is not a retryable error

        if (err instanceof InvalidImageFormatException && !triedTranscode) {
          // Rekognition only accepts JPEG/PNG (WEBP in some regions) and threw
          // InvalidImageFormatException for this format. Try a jimp transcode before giving
          // up - checked reactively (not proactively) so region-dependent formats like WEBP
          // only pay the transcode cost when Rekognition actually rejects them.
          triedTranscode = true;
          try {
            image = await this.transcodeToJpeg(image);
            this.logger.warn(
              '[ImageModeration] Rekognition rejected the original format; transcoded to JPEG via jimp and retrying'
            );
            attempt--; // retry with the transcoded bytes without burning a transient-retry attempt
            continue;
          } catch (transcodeErr) {
            // jimp can't decode it either (e.g. HEIC, SVG) - a confirmed unsupported format,
            // not a transient failure. Terminal: must not retry forever.
            this.logger.warn(
              `[ImageModeration] unsupported image format, cannot transcode: ${(transcodeErr as Error).message}`
            );
            throw new UnsupportedImageFormatError(
              `Rekognition rejected the format (${err.name}) and it could not be transcoded: ${(transcodeErr as Error).message}`
            );
          }
        }

        lastError = err;
        this.logger.warn(
          `[ImageModeration] Rekognition attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err as Error).message}`
        );
      }
    }
    // Fail closed: never treat an unavailable detector as "clean".
    throw new Error(
      `[ImageModeration] moderation unavailable after ${MAX_ATTEMPTS} attempts: ${(lastError as Error)?.message}`
    );
  }
}
