import type { speechToTextService } from '@bike4mind/services';

// S3 prefix for transient audio uploads. Must match the appFileUploadComplete
// skip-list and the appFilesBucketLifecycle expiration rule in infra/buckets.ts.
export const TRANSCRIBE_UPLOAD_PREFIX = 'transcribe-uploads/';

// Extension hint encoded into S3 keys so downstream tools (Whisper, AWS
// Transcribe) can infer the format from the filename. Typed against
// AllowedAudioMimeType so allowlist changes force this map to stay in sync.
export const MIME_TO_EXTENSION: Record<speechToTextService.AllowedAudioMimeType, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};
