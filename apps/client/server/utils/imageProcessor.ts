import { Jimp } from 'jimp';

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
 * Lambda handler for image processing
 * Converts images to PNG and resizes if needed to meet size requirements
 * Uses jimp (pure JS, no native dependencies) for reliability in Lambda
 */
export const handler = async (event: ImageProcessRequest): Promise<ImageProcessResponse> => {
  try {
    const { imageBuffer: imageBufferBase64, maxSizeMB = 4 } = event;

    console.log(`[ImageProcessor] Starting image processing with max size ${maxSizeMB}MB...`);

    const imageBuffer = Buffer.from(imageBufferBase64, 'base64');
    console.log(`[ImageProcessor] Input buffer size: ${(imageBuffer.length / (1024 * 1024)).toFixed(2)}MB`);

    const baseImage: any = await Jimp.read(imageBuffer);
    console.log(`[ImageProcessor] Image loaded: ${baseImage.bitmap.width}x${baseImage.bitmap.height}`);

    const originalWidth = baseImage.bitmap.width;
    const originalHeight = baseImage.bitmap.height;

    // If very large, resize before converting to PNG - much faster than converting first.
    const estimatedSizeMB = (originalWidth * originalHeight * 4) / (1024 * 1024); // 4 bytes per pixel

    let workingImage: any = baseImage;
    if (estimatedSizeMB > maxSizeMB * 1.5) {
      const scaleFactor = Math.sqrt((maxSizeMB * 1.2) / estimatedSizeMB);
      const targetWidth = Math.floor(originalWidth * scaleFactor);
      const targetHeight = Math.floor(originalHeight * scaleFactor);

      console.log(
        `[ImageProcessor] Large image detected (est. ${estimatedSizeMB.toFixed(2)}MB), pre-resizing to ${targetWidth}x${targetHeight}...`
      );
      workingImage = baseImage.clone().resize({ w: targetWidth, h: targetHeight });
      console.log(`[ImageProcessor] Pre-resize complete`);
    }

    let processedBuffer = await workingImage.getBuffer('image/png');
    let currentSizeMB = processedBuffer.length / (1024 * 1024);
    console.log(`[ImageProcessor] PNG conversion size: ${currentSizeMB.toFixed(2)}MB`);

    // Fine-tune resize if still too large
    if (currentSizeMB > maxSizeMB) {
      console.log(`[ImageProcessor] Image size ${currentSizeMB.toFixed(2)}MB exceeds ${maxSizeMB}MB, fine-tuning...`);

      let scaleFactor = Math.sqrt(maxSizeMB / currentSizeMB) * 0.95; // 0.95 for safety margin

      let attempts = 0;
      const maxAttempts = 5; // Reduced attempts since we pre-resized

      while (currentSizeMB > maxSizeMB && attempts < maxAttempts) {
        const newWidth = Math.floor(workingImage.bitmap.width * scaleFactor);
        const newHeight = Math.floor(workingImage.bitmap.height * scaleFactor);

        console.log(
          `[ImageProcessor] Attempt ${attempts + 1}: Resizing to ${newWidth}x${newHeight} (scale: ${scaleFactor.toFixed(2)})...`
        );

        const resizedImage = workingImage.clone().resize({ w: newWidth, h: newHeight });
        processedBuffer = await resizedImage.getBuffer('image/png');
        currentSizeMB = processedBuffer.length / (1024 * 1024);

        console.log(`[ImageProcessor] New size: ${currentSizeMB.toFixed(2)}MB`);

        if (currentSizeMB > maxSizeMB) {
          scaleFactor *= 0.85;
        }

        attempts++;
      }

      if (currentSizeMB > maxSizeMB) {
        throw new Error(
          `Unable to reduce image size below ${maxSizeMB}MB after ${attempts} attempts. ` +
            `Current size: ${currentSizeMB.toFixed(2)}MB. ` +
            `Please use a smaller source image.`
        );
      }

      console.log(`[ImageProcessor] Image successfully resized to ${currentSizeMB.toFixed(2)}MB`);
    }

    return {
      processedBuffer: processedBuffer.toString('base64'),
      sizeMB: currentSizeMB,
      isPng: true,
    };
  } catch (error) {
    console.error(`[ImageProcessor] Error processing image:`, error);
    if (error instanceof Error && error.message.includes('Could not find MIME')) {
      throw new Error(
        `Invalid image format. Please ensure the image is a valid JPEG, PNG, WebP, GIF, or other supported format.`
      );
    }
    throw error;
  }
};
