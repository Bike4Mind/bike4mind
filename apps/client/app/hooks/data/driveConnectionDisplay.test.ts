import { describe, it, expect } from 'vitest';
import { describeDriveConnection } from './driveConnectionDisplay';

const conn = (over: Partial<Parameters<typeof describeDriveConnection>[0]> = {}) => ({
  status: 'connected' as const,
  lastError: null,
  folderName: 'Handbook',
  driveFolderId: 'FOLDER',
  ...over,
});

describe('describeDriveConnection', () => {
  it('reads a clean connected sync as healthy', () => {
    expect(describeDriveConnection(conn())).toEqual({
      label: 'Connected',
      title: 'Syncing the Google Drive folder "Handbook"',
      color: 'success',
    });
  });

  // The silently-incomplete-lake case (#2394): releaseSyncClaim stamps the status back to
  // 'connected' whatever happened, so lastError is the ONLY thing separating a finished sync from
  // one that stopped short with files missing. Reporting that green is the bug.
  it('does NOT read a connected connection carrying a lastError as healthy', () => {
    const { label, title, color } = describeDriveConnection(
      conn({ lastError: 'Google Drive is rate-limiting this sync, and it stopped after 20 continuation runs.' })
    );
    expect(color).toBe('warning');
    expect(label).toBe('Stopped short');
    expect(title).toContain('last sync stopped short');
    expect(title).toContain('rate-limiting');
    expect(title).not.toContain('Syncing the Google Drive folder');
  });

  it('keeps the badge wording and severity for a genuinely broken connection', () => {
    expect(describeDriveConnection(conn({ status: 'credential_error', lastError: 'invalid_grant' }))).toEqual({
      label: 'Credential error',
      title: 'Google Drive folder "Handbook": credential error - invalid_grant',
      color: 'danger',
    });
  });

  it('falls back to the folder id when Drive gave us no folder name', () => {
    expect(describeDriveConnection(conn({ folderName: null })).title).toContain('"FOLDER"');
  });
});
