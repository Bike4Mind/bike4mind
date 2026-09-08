/**
 * How a Drive connection READS to a user: label, tooltip line, severity.
 *
 * Deliberately free of hook/API imports so every surface can call it directly and no test suite has
 * to stub it - three hand-copied wording tables is exactly the drift this consolidates.
 */

import type { GoogleDriveConnectionStatus } from '@bike4mind/common';

/**
 * Derived from the stored enum rather than re-listed. The drive-connection endpoint returns
 * `c.status` verbatim with no contract validation, so a status this module does not know about
 * reaches the badge lookup as `undefined` and every surface below throws a render-time TypeError.
 * 'syncing' is exactly how that bit: it is a real stored status for the whole duration of a sync,
 * was missing from the hand-listed union, and crashed both Drive surfaces while a sync ran.
 */
export type DriveConnectionStatus = GoogleDriveConnectionStatus;

export type DriveConnectionSeverity = 'success' | 'warning' | 'danger';

/**
 * Wording + severity per raw status. Every surface that renders a Drive connection (the wizard's
 * connect action, the lake detail chip) reads the SAME table - hand-synced copies would drift the
 * moment a status is added.
 */
export const DRIVE_STATUS_BADGE: Record<DriveConnectionStatus, { label: string; color: DriveConnectionSeverity }> = {
  connected: { label: 'Connected', color: 'success' },
  syncing: { label: 'Syncing', color: 'success' },
  needs_reconnect: { label: 'Needs reconnect', color: 'warning' },
  credential_error: { label: 'Credential error', color: 'danger' },
};

/** Last resort if an unvalidated status still slips past the derived union (see DriveConnectionStatus). */
const UNKNOWN_STATUS_BADGE = { label: 'Unknown', color: 'warning' } as const;

/** The subset of a connection this wording is derived from. */
export type DescribableDriveConnection = {
  status: DriveConnectionStatus;
  lastError: string | null;
  folderName: string | null;
  driveFolderId: string;
};

/**
 * The subtlety is `connected` WITH a `lastError`. Releasing a sync claim always stamps the status
 * back to 'connected' and records why the run stopped short on `lastError`
 * (OrgGoogleDriveConnectionModel.releaseSyncClaim), so that pair means the last sync did NOT finish -
 * files are missing from the lake. Reporting it as a plain green "Connected" is the silently-
 * incomplete lake this exists to stop (#2394), and `lastError` is the only account of it that
 * reaches a user at all.
 */
export function describeDriveConnection(connection: DescribableDriveConnection): {
  label: string;
  title: string;
  color: DriveConnectionSeverity;
} {
  const folder = connection.folderName || connection.driveFolderId;
  const badge = DRIVE_STATUS_BADGE[connection.status] ?? UNKNOWN_STATUS_BADGE;

  // A run is in flight, so any lastError belongs to the PREVIOUS one - reporting this as a sync that
  // stopped short would be wrong. DriveConnectAction still renders the old message on its own line.
  if (connection.status === 'syncing') {
    return {
      label: badge.label,
      title: `Sync in progress for the Google Drive folder "${folder}"`,
      color: badge.color,
    };
  }

  if (connection.status === 'connected') {
    return connection.lastError
      ? {
          label: 'Stopped short',
          title: `Google Drive folder "${folder}": last sync stopped short - ${connection.lastError}`,
          color: 'warning',
        }
      : { label: badge.label, title: `Syncing the Google Drive folder "${folder}"`, color: badge.color };
  }

  const detail = connection.lastError ? ` - ${connection.lastError}` : '';
  return {
    label: badge.label,
    title: `Google Drive folder "${folder}": ${badge.label.toLowerCase()}${detail}`,
    color: badge.color,
  };
}
