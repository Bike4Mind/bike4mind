/**
 * Client-side image resizing utility using Canvas API
 * Reduces image size before upload to avoid server-side issues
 */

export interface ImageResizeOptions {
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
  quality?: number;
}

/**
 * Resizes an image file on the client side using Canvas API
 * @param file - The image file to resize
 * @param options - Resize options (maxSizeMB, maxWidthOrHeight, quality)
 * @returns A Promise that resolves to the resized File
 */
export async function resizeImageFile(file: File, options: ImageResizeOptions = {}): Promise<File> {
  const {
    maxSizeMB = 3, // Default to 3MB (safe for Anthropic/Gemini base64 limits)
    maxWidthOrHeight = 2000, // Bedrock limits to 2000px for multi-image requests
    quality = 0.9, // Default quality (0-1)
  } = options;

  // Only process image files
  if (!file.type.startsWith('image/')) {
    return file;
  }

  const originalSizeMB = file.size / (1024 * 1024);
  console.log(`[ImageResizer] Original image: ${originalSizeMB.toFixed(2)}MB`);

  // If image is already small enough, return it as-is
  if (originalSizeMB <= maxSizeMB) {
    console.log(`[ImageResizer] Image is already under ${maxSizeMB}MB, no resize needed`);
    return file;
  }

  console.log(`[ImageResizer] Resizing image from ${originalSizeMB.toFixed(2)}MB to target ${maxSizeMB}MB...`);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    img.onload = () => {
      try {
        // Calculate new dimensions
        let { width, height } = img;

        // First, limit dimensions
        if (width > maxWidthOrHeight || height > maxWidthOrHeight) {
          if (width > height) {
            height = (height / width) * maxWidthOrHeight;
            width = maxWidthOrHeight;
          } else {
            width = (width / height) * maxWidthOrHeight;
            height = maxWidthOrHeight;
          }
        }

        // Calculate scale factor needed to hit target file size
        // File size roughly scales with pixel count, so use square root
        const targetBytes = maxSizeMB * 1024 * 1024;
        const scaleFactor = Math.sqrt(targetBytes / file.size);

        // Apply scale factor if we need more reduction
        if (scaleFactor < 1) {
          width = Math.floor(width * scaleFactor);
          height = Math.floor(height * scaleFactor);
        }

        console.log(`[ImageResizer] Resizing to ${width}x${height}`);

        // Set canvas dimensions
        canvas.width = width;
        canvas.height = height;

        // Draw resized image
        ctx.drawImage(img, 0, 0, width, height);

        // Smart iterative approach: try quality first, then dimensions if needed
        let currentQuality = quality;
        let attempts = 0;
        let totalAttempts = 0;
        const maxQualityAttempts = 8;
        const maxTotalAttempts = 20; // Safety limit to prevent infinite loops
        let currentWidth = width;
        let currentHeight = height;
        let bestBlob: Blob | null = null;
        let bestSizeMB = 0;

        const tryConvert = () => {
          canvas.toBlob(
            blob => {
              if (!blob) {
                reject(new Error('Failed to create blob from canvas'));
                return;
              }

              const resultSizeMB = blob.size / (1024 * 1024);
              totalAttempts++;

              console.log(
                `[ImageResizer] Attempt ${totalAttempts}/${maxTotalAttempts}: ${resultSizeMB.toFixed(2)}MB at quality ${currentQuality.toFixed(2)}, size ${currentWidth}x${currentHeight}`
              );

              // Keep track of best result under limit (closest to target)
              if (resultSizeMB <= maxSizeMB && resultSizeMB > bestSizeMB) {
                bestBlob = blob;
                bestSizeMB = resultSizeMB;
              }

              // Safety: if we've tried too many times, return best result
              if (totalAttempts >= maxTotalAttempts) {
                if (bestBlob) {
                  const resizedFile = new File([bestBlob], file.name, {
                    type: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
                    lastModified: Date.now(),
                  });
                  console.log(
                    `[ImageResizer] Max attempts reached. Using best result: ${bestSizeMB.toFixed(2)}MB (${((bestSizeMB / maxSizeMB) * 100).toFixed(1)}% of target)`
                  );
                  resolve(resizedFile);
                  return;
                } else {
                  // Last resort: use current even if over limit
                  const resizedFile = new File([blob], file.name, {
                    type: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
                    lastModified: Date.now(),
                  });
                  console.log(`[ImageResizer] Max attempts reached. Best effort: ${resultSizeMB.toFixed(2)}MB`);
                  resolve(resizedFile);
                  return;
                }
              }

              // If size is good and close to target (within 95-100% of maxSize), we're done!
              if (resultSizeMB <= maxSizeMB && resultSizeMB >= maxSizeMB * 0.85) {
                const resizedFile = new File([blob], file.name, {
                  type: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
                  lastModified: Date.now(),
                });

                console.log(
                  `[ImageResizer] Success! Resized from ${originalSizeMB.toFixed(2)}MB to ${resultSizeMB.toFixed(2)}MB (${((resultSizeMB / maxSizeMB) * 100).toFixed(1)}% of target)`
                );
                resolve(resizedFile);
                return;
              }

              attempts++;

              // If we've tried quality reduction and still too large, reduce dimensions
              if (attempts >= maxQualityAttempts && resultSizeMB > maxSizeMB) {
                // Calculate how much we need to reduce dimensions
                // File size scales roughly with pixel count (width * height)
                const dimensionScaleFactor = Math.sqrt(maxSizeMB / resultSizeMB) * 0.95; // 95% for safety margin
                currentWidth = Math.floor(currentWidth * dimensionScaleFactor);
                currentHeight = Math.floor(currentHeight * dimensionScaleFactor);

                // Safety: don't reduce below reasonable size
                if (currentWidth < 100 || currentHeight < 100) {
                  // Image is too small, use best result we have or current
                  const finalBlob = bestBlob || blob;
                  const finalSize = bestBlob ? bestSizeMB : resultSizeMB;
                  const resizedFile = new File([finalBlob], file.name, {
                    type: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
                    lastModified: Date.now(),
                  });
                  console.log(`[ImageResizer] Minimum size reached. Using result: ${finalSize.toFixed(2)}MB`);
                  resolve(resizedFile);
                  return;
                }

                // Redraw at new dimensions
                canvas.width = currentWidth;
                canvas.height = currentHeight;
                ctx.drawImage(img, 0, 0, currentWidth, currentHeight);

                // Reset quality and attempts for new dimensions
                currentQuality = 0.9;
                attempts = 0;
                console.log(
                  `[ImageResizer] Reducing dimensions to ${currentWidth}x${currentHeight} (scale factor: ${dimensionScaleFactor.toFixed(2)})`
                );
              } else if (resultSizeMB > maxSizeMB) {
                // Still too large, reduce quality more precisely
                const qualityScaleFactor = Math.pow(maxSizeMB / resultSizeMB, 0.5); // Square root for gentler adjustment
                currentQuality = Math.max(0.5, currentQuality * qualityScaleFactor);
              } else if (resultSizeMB < maxSizeMB * 0.85 && attempts < maxQualityAttempts) {
                // Under target but want to get closer - try slightly higher quality
                currentQuality = Math.min(1.0, currentQuality * 1.05);
              } else {
                // Good enough, use best result (or current if no best)
                const finalBlob = bestBlob || blob;
                const finalSize = bestBlob ? bestSizeMB : resultSizeMB;
                const resizedFile = new File([finalBlob], file.name, {
                  type: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
                  lastModified: Date.now(),
                });
                console.log(
                  `[ImageResizer] Success! Resized from ${originalSizeMB.toFixed(2)}MB to ${finalSize.toFixed(2)}MB (${((finalSize / maxSizeMB) * 100).toFixed(1)}% of target)`
                );
                resolve(resizedFile);
                return;
              }

              tryConvert();
            },
            file.type === 'image/png' ? 'image/png' : 'image/jpeg',
            currentQuality
          );
        };

        tryConvert();
      } catch (error) {
        reject(error);
      } finally {
        // Clean up
        URL.revokeObjectURL(img.src);
      }
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
      URL.revokeObjectURL(img.src);
    };

    // Load the image
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Helper to check if a file is an image
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/**
 * Helper to format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
