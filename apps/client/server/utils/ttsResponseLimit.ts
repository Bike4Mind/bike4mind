// API Gateway/Lambda cap a function's response payload at ~6MB, and the proxy
// integration base64-wraps the body (~+33%) for both raw-binary and JSON audio
// responses. So the raw audio buffer must stay under ~4.5MB; we use 4MB for
// margin. Past this the request fails with an opaque CloudFront 502/504 - this
// guard turns that into a clean, documented 413. The real long-form fix is to
// offload large audio to S3 and return a URL (mirrors the image pipeline);
// tracked in #745.
export const TTS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function exceedsTtsResponseLimit(audioBytes: number): boolean {
  return audioBytes > TTS_MAX_RESPONSE_BYTES;
}

export const TTS_RESPONSE_TOO_LARGE_MESSAGE =
  'Generated audio is too large to return over this endpoint (~4MB limit). Shorten the input, or switch to a compressed format (mp3) if you requested wav or pcm.';
