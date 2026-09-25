import { Logger } from '@bike4mind/observability';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { AxiosResponse } from 'axios';

/**
 * AWS Lambda hard limit for synchronous (RequestResponse) invocation payloads.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
 */
const LAMBDA_SYNC_PAYLOAD_LIMIT_BYTES = 6_291_456; // 6 MB

/**
 * Max raw image size we allow into the synchronous ImageProcessor invocation.
 * base64 inflates bytes by ~4/3, and the JSON envelope adds a small constant,
 * so a raw image > ~4.5 MB produces a payload over the 6 MB Lambda limit.
 * We guard at 4.4 MiB to leave margin for the JSON wrapper and key names.
 * Use binary MiB (matches how currentSizeMB is computed) so the constant,
 * the user-facing message, and the PR description all agree on "4.4MB".
 */
const MAX_RAW_IMAGE_BYTES = 4.4 * 1024 * 1024; // 4.4 MiB

/** Whole-chain budget for fetching a source image, redirects included. */
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

/** Safety net against an unbounded response body; the size policy is enforced downstream. */
const MAX_IMAGE_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Redirect hops followed before giving up. Every hop is re-validated against the SSRF guard. Kept
 * equal to `MAX_REDIRECTS` in `fab-pipeline/src/ingest.ts` so the two fetchers do not disagree about
 * what a reachable URL is.
 */
const MAX_IMAGE_REDIRECTS = 5;

/**
 * Origin of an operator-configured S3-compatible endpoint (self-host MinIO, localstack), or null on
 * hosted AWS where `AWS_ENDPOINT_URL_S3` is unset. Matches how `S3Storage` reads the same variable.
 *
 * Read per call rather than snapshotted at module load, because the Lambda runtime and the tests
 * both set the environment after this module is imported.
 */
function configuredStorageOrigin(): string | null {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

function sameOrigin(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Renders a URL safe to write to logs: origin and path only, never userinfo, query, or
 * fragment, since a caller-supplied or presigned URL can carry a credential (an access token,
 * an S3 signature) in any of those. Never called with a `data:` URL - its base64 payload has
 * no safe partial form.
 */
function redactedUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<unparseable URL>';
  }
}

export interface ImageProcessRequest {
  imageBuffer: string; // base64 encoded buffer
  maxSizeMB?: number;
}

export interface ImageProcessResponse {
  processedBuffer: string; // base64 encoded buffer
  sizeMB: number;
  isPng: boolean;
}

/**
 * Invokes the image processor Lambda to convert and resize images
 * This is a serverless alternative to using sharp directly
 *
 * @param imageBuffer - The image buffer to process
 * @param lambdaFunctionName - The name of the Lambda function to invoke (e.g., from SST Resource.ImageProcessor.name)
 * @param maxSizeMB - Maximum size in MB for the output image
 */
export async function invokeImageProcessor(
  imageBuffer: Buffer,
  lambdaFunctionName: string,
  maxSizeMB: number = 4
): Promise<Buffer> {
  try {
    const currentSizeMB = imageBuffer.length / (1024 * 1024);
    Logger.globalInstance.log(`[ImageProcessorUtils] Input size: ${currentSizeMB.toFixed(2)}MB, max: ${maxSizeMB}MB`);

    // Check if it's already a PNG by looking at the magic bytes
    const isPng =
      imageBuffer.length >= 8 &&
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47;

    // Fast path: if already PNG and small enough, skip processing entirely
    if (isPng && currentSizeMB <= maxSizeMB) {
      Logger.globalInstance.log(
        `[ImageProcessorUtils] ✅ Image is already PNG and under ${maxSizeMB}MB - skipping processing`
      );
      return imageBuffer;
    }

    Logger.globalInstance.log(
      `[ImageProcessorUtils] Processing needed - isPng: ${isPng}, needsResize: ${currentSizeMB > maxSizeMB}`
    );

    if (!lambdaFunctionName) {
      throw new Error(
        'ImageProcessor Lambda function name is required. Please pass the Lambda function name as an argument.'
      );
    }

    // Guard: the image is base64-encoded into a synchronous Lambda payload, which
    // AWS caps at 6 MB. base64 inflates the buffer ~4/3, so an oversized image
    // would trigger a non-retryable client-side RequestEntityTooLargeException
    // before the ImageProcessor Lambda ever runs. Fail fast with an actionable
    // message instead. (Long-term fix: pass the image via S3 instead of payload.)
    if (imageBuffer.length > MAX_RAW_IMAGE_BYTES) {
      const projectedPayloadMB = ((imageBuffer.length * 4) / 3 / (1024 * 1024)).toFixed(2);
      const maxRawMB = (MAX_RAW_IMAGE_BYTES / (1024 * 1024)).toFixed(1);
      throw new Error(
        `Image too large (${currentSizeMB.toFixed(2)}MB). ` +
          `Images sent for editing must be under ${maxRawMB}MB ` +
          `(encoding would produce a ~${projectedPayloadMB}MB request, exceeding the ${(
            LAMBDA_SYNC_PAYLOAD_LIMIT_BYTES /
            (1024 * 1024)
          ).toFixed(0)}MB limit). Please resize the image and try again.`
      );
    }

    const lambdaClient = new LambdaClient({});

    const request: ImageProcessRequest = {
      imageBuffer: imageBuffer.toString('base64'),
      maxSizeMB,
    };

    Logger.globalInstance.log(`[ImageProcessorUtils] Invoking ImageProcessor Lambda: ${lambdaFunctionName}`);

    const command = new InvokeCommand({
      FunctionName: lambdaFunctionName,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(request),
    });

    const response = await lambdaClient.send(command);

    if (response.FunctionError) {
      const errorPayload = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : {};
      throw new Error(`ImageProcessor Lambda error: ${errorPayload.errorMessage || 'Unknown error'}`);
    }

    if (!response.Payload) {
      throw new Error('ImageProcessor Lambda returned no payload');
    }

    const result: ImageProcessResponse = JSON.parse(Buffer.from(response.Payload).toString());

    if (!result.processedBuffer) {
      throw new Error(
        `ImageProcessor Lambda returned invalid response - missing processedBuffer. Response: ${JSON.stringify(result)}`
      );
    }

    Logger.globalInstance.log(`[ImageProcessorUtils] Image processed successfully:`, {
      outputSizeMB: result.sizeMB,
      isPng: result.isPng,
    });

    return Buffer.from(result.processedBuffer, 'base64');
  } catch (error) {
    Logger.globalInstance.error(`[ImageProcessorUtils] Error invoking ImageProcessor Lambda:`, error);
    throw error;
  }
}

/**
 * Downloads an image from a URL or decodes a data URL.
 *
 * SECURITY: `imageUrl` can be caller-supplied (the public edit-image request body accepts a bare
 * string), and this runs inside the VPC, so an unguarded GET here is an SSRF primitive against the
 * instance metadata endpoint and anything else on the internal network. The guard is the same
 * two-part shape as `fetchAndParseURL` in `@bike4mind/fab-pipeline`: `validateUrlForFetch` judges
 * the scheme and the address of every URL in the chain, and the pinned agents' connect-time lookup
 * judges the IP each socket actually dials, which is what closes the DNS-rebinding window between
 * the two resolutions. Redirects are followed manually with `maxRedirects: 0` so no hop escapes the
 * per-hop validation.
 *
 * SELF-HOST EXEMPTION: when `AWS_ENDPOINT_URL_S3` names an S3-compatible endpoint, the signed URLs
 * this app generates point at it - and on a compose network that host resolves to a private address,
 * which both halves of the guard would refuse, breaking image-to-image entirely. The caller must opt
 * in with `trustConfiguredStorageOrigin` - never inferred from the URL alone - so the exemption only
 * ever applies to a URL a caller freshly produced from `BaseStorage.getSignedUrl`, never to a
 * caller-supplied or provider-returned one that merely happens to share that origin. It also only
 * ever covers the URL as given: it is checked once, before hop 0, and a redirect - even one that
 * lands back on the configured origin - cannot regain it, so an untrusted URL can never launder
 * itself through the exemption by bouncing off the configured host.
 */
export async function downloadImageAsBuffer(
  imageUrl: string,
  options: { trustConfiguredStorageOrigin?: boolean } = {}
): Promise<Buffer> {
  // Handle data URLs (base64 images) from previous generations. Checked, and short-circuited,
  // before any logging: a data URL's payload has no safe partial form to print.
  if (imageUrl.startsWith('data:image/')) {
    Logger.globalInstance.log(`[ImageProcessorUtils] Processing base64 data URL`);
    const base64Data = imageUrl.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  Logger.globalInstance.log(`[ImageProcessorUtils] Downloading image from URL:`, redactedUrlForLogging(imageUrl));

  // Handle regular URLs - use dynamic import to avoid bundling axios if not needed
  Logger.globalInstance.log(`[ImageProcessorUtils] Fetching image from HTTP URL`);
  const axios = (await import('axios')).default;
  const { validateUrlForFetch, ssrfSafeHttpAgent, ssrfSafeHttpsAgent } = await import('@bike4mind/fab-pipeline');

  let currentUrl = imageUrl;
  let response: AxiosResponse<Buffer> | null = null;

  // ONE budget for the whole chain rather than per hop, so a redirect chain cannot multiply the
  // worst case by MAX_IMAGE_REDIRECTS and blow the caller's Lambda timeout.
  const deadline = Date.now() + IMAGE_FETCH_TIMEOUT_MS;

  // Decided once, from the URL as given, never recomputed against a redirect target - see the
  // SELF-HOST EXEMPTION note above.
  const isTrustedStorageUrl =
    options.trustConfiguredStorageOrigin === true && sameOrigin(imageUrl, configuredStorageOrigin());

  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const isTrustedStorageHop = hop === 0 && isTrustedStorageUrl;

    if (!isTrustedStorageHop) {
      const validation = await validateUrlForFetch(currentUrl);
      if (!validation.valid) {
        throw new Error(`Image URL blocked for security reasons: ${validation.error}`);
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out while following redirects for image URL');
    }

    const hopResponse: AxiosResponse<Buffer> = await axios.get(currentUrl, {
      // BOTH agents: the scheme is not fixed across a chain, and axios picks the agent per request
      // from the scheme it is currently on. Omitted on a trusted storage hop, whose address the
      // connect-time lookup would refuse for the same reason the pre-flight would.
      ...(isTrustedStorageHop ? {} : { httpAgent: ssrfSafeHttpAgent, httpsAgent: ssrfSafeHttpsAgent }),
      // MUST accompany the agents. axios reads HTTPS_PROXY/HTTP_PROXY from the environment by
      // default and then installs its own agent, which would silently drop the connect-time pin
      // while every URL-level check still passed.
      proxy: false,
      responseType: 'arraybuffer',
      timeout: remainingMs,
      maxRedirects: 0,
      maxContentLength: MAX_IMAGE_RESPONSE_BYTES,
      maxBodyLength: MAX_IMAGE_RESPONSE_BYTES,
      // 3xx must reach us as a value rather than a throw; anything else keeps axios's default.
      validateStatus: status => (status >= 200 && status < 300) || (status >= 300 && status < 400),
    });

    response = hopResponse;
    if (hopResponse.status < 300) break;

    const location = hopResponse.headers?.location;
    if (typeof location !== 'string' || location.length === 0) {
      throw new Error(`Image URL returned status ${hopResponse.status} with no redirect target`);
    }

    if (hop === MAX_IMAGE_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_IMAGE_REDIRECTS}) while fetching image URL`);
    }

    // Resolved against the CURRENT url so a relative Location works, and re-validated at the top of
    // the next iteration before anything is requested from it.
    currentUrl = new URL(location, currentUrl).toString();
  }

  if (!response) {
    // Unreachable: the loop always assigns before breaking. Guards the type, not a real case.
    throw new Error('Image URL fetch produced no response');
  }

  Logger.globalInstance.log(`[ImageProcessorUtils] Image downloaded:`, {
    status: response.status,
    contentLength: response.headers['content-length'],
    contentType: response.headers['content-type'],
    bufferSize: response.data.length,
  });

  return Buffer.from(response.data);
}
