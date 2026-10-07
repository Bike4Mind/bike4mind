/**
 * Error codes the Google Drive connect callback (pages/api/google-drive/callback.ts) returns
 * with a 400, and the callback page (app/routes/google-drive/callback.tsx) maps to messages.
 */
export const GOOGLE_DRIVE_CONNECT_ERROR = {
  expired: 'GOOGLE_DRIVE_CONNECT_EXPIRED',
  invalid: 'GOOGLE_DRIVE_CONNECT_INVALID',
  failed: 'GOOGLE_DRIVE_CONNECT_FAILED',
} as const;
