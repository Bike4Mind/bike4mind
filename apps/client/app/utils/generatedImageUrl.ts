// Extract the S3 key from an image URL
export const extractS3KeyFromUrl = (imageUrl: string): string | null => {
  try {
    const url = new URL(imageUrl);

    // Check if it's an S3 URL (either S3 domain or presigned URL)
    if (url.hostname.includes('generatedimagesbucket') || url.hostname.includes('s3')) {
      // Generated keys are bare (no prefix); take the last path segment so a path-style host
      // (bucket in the path) works too. pathname already excludes the presign query string.
      const lastSegment = url.pathname.split('/').filter(Boolean).pop();
      return lastSegment ? decodeURIComponent(lastSegment) : null;
    }

    return null;
  } catch (error) {
    console.error('Error parsing image URL:', error);
    return null;
  }
};

// Whether an image URL points at the generated-images bucket
export const isGeneratedImage = (imageUrl: string): boolean => {
  return imageUrl.includes('generatedimagesbucket');
};
