import { MAIL_BODY_PREFIX } from '../utils/mailer/mailBodyStore';
import { TEXT_EDIT_BACKUP_PREFIX } from '../utils/textEditBackupPrefix';

/**
 * App-files bucket prefixes written without an AppFile row, so the upload-complete handler
 * (apps/workers/src/s3/appFileUploadComplete.ts) skips them before the lookup. A new system or
 * overlay writer to this bucket adds its prefix here. Overlay-owned prefixes are noted: a rename
 * there silently disables the skip.
 */
export const UNTRACKED_APP_FILE_PREFIXES = [
  TEXT_EDIT_BACKUP_PREFIX,
  'temp/',
  'tmp/',
  // Quest/plan exports from the queue handlers, delivered over WebSocket.
  'exports/',
  // External image cache (cacheExternalImage.ts).
  'proxied-images/',
  // Owned by the tavern premium overlay (seed/promote write via presigned URLs).
  'tavern-sounds/',
  // Icon packs uploaded by packages/scripts/src/uploadTavernIcons.ts.
  'tavern-icons/',
  // Owned by the tavern premium overlay's binary upload script.
  'cc-bridge/',
  // Per-user bundles from pages/api/cc-bridge/download.ts.
  'cc-bridge-downloads/',
  // Transient audio for /api/ai/transcribe, and Transcribe job outputs (speechService).
  'transcribe-uploads/',
  'transcripts/',
  // Public settings artifact (publicSettingsArtifact.ts), served via CDN.
  'app-config/',
  // Tracked by an OrgFeedbackSummaryJob row instead (orgFeedbackSummary.ts summaryS3Key).
  'org-feedback-summaries/',
  // Owned by a premium overlay's run worker (bobRunQueue in infra/queues.ts).
  'bob-screenshots/',
  // Mail bodies too large for an email.send event (mailBodyStore.ts).
  MAIL_BODY_PREFIX,
] as const;

export const isUntrackedAppFileKey = (key: string): boolean =>
  key.includes('/backups/') || UNTRACKED_APP_FILE_PREFIXES.some(prefix => key.startsWith(prefix));
