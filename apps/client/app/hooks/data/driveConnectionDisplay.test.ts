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

  // 'syncing' is a real stored status the hand-listed client union used to omit, so the badge lookup
  // came back undefined and both Drive surfaces threw `Cannot read properties of undefined` for the
  // whole duration of a sync. The union is derived from the DB enum now, which is what stops it.
  it('describes an in-flight sync instead of throwing on it', () => {
    const { label, title, color } = describeDriveConnection(conn({ status: 'syncing' }));
    expect(label).toBe('Syncing');
    expect(title).toBe('Sync in progress for the Google Drive folder "Handbook"');
    expect(color).toBe('success');
  });

  it('does not dress an in-flight sync as stopped-short using the PREVIOUS run error', () => {
    const { label, title } = describeDriveConnection(conn({ status: 'syncing', lastError: 'a previous failure' }));
    expect(label).toBe('Syncing');
    expect(title).not.toContain('stopped short');
  });

  it('never throws on a status no longer in the badge table', () => {
    // The endpoint hands back the raw stored status with no validation, so this is the boundary the
    // fallback exists for - a crash here takes out the whole lake panel.
    const rogue = conn({ status: 'a_status_from_the_future' as never });
    expect(() => describeDriveConnection(rogue)).not.toThrow();
    expect(describeDriveConnection(rogue).color).toBe('warning');
  });

  it('falls back to the folder id when Drive gave us no folder name', () => {
    expect(describeDriveConnection(conn({ folderName: null })).title).toContain('"FOLDER"');
  });
});
