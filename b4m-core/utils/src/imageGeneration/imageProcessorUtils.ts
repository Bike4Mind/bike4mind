import { Logger } from '@bike4mind/observability';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

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
 * Downloads an image from a URL or decodes a data URL
 */
export async function downloadImageAsBuffer(imageUrl: string): Promise<Buffer> {
  Logger.globalInstance.log(`[ImageProcessorUtils] Downloading image from URL:`, imageUrl.substring(0, 100) + '...');

  // Handle data URLs (base64 images) from previous generations
  if (imageUrl.startsWith('data:image/')) {
    Logger.globalInstance.log(`[ImageProcessorUtils] Processing base64 data URL`);
    const base64Data = imageUrl.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  // Handle regular URLs - use dynamic import to avoid bundling axios if not needed
  Logger.globalInstance.log(`[ImageProcessorUtils] Fetching image from HTTP URL`);
  const axios = (await import('axios')).default;
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000, // 30 second timeout
    maxContentLength: 50 * 1024 * 1024, // 50MB max (we'll validate later)
  });

  Logger.globalInstance.log(`[ImageProcessorUtils] Image downloaded:`, {
    status: response.status,
    contentLength: response.headers['content-length'],
    contentType: response.headers['content-type'],
    bufferSize: response.data.length,
  });

  return Buffer.from(response.data);
}
