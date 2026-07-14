import { describe, it, expect } from 'vitest';
import { appendEditedVersion, nextVersionNumber, versionedFileKey } from './fabfile';

describe('nextVersionNumber', () => {
  it('starts at 1 when there is no history', () => {
    expect(nextVersionNumber()).toBe(1);
    expect(nextVersionNumber([])).toBe(1);
  });

  it('is one past the highest existing version (not just the array length)', () => {
    expect(nextVersionNumber([{ version: 1 }, { version: 2 }])).toBe(3);
    // Robust to out-of-order or gapped histories.
    expect(nextVersionNumber([{ version: 3 }, { version: 1 }])).toBe(4);
  });
});

describe('versionedFileKey', () => {
  it('namespaces by user and file and preserves the original file name', () => {
    expect(versionedFileKey({ userId: 'u1', fabFileId: 'f9', fileName: 'report.docx', version: 2 })).toBe(
      'files/u1/f9/v2_report.docx'
    );
  });
});

describe('appendEditedVersion', () => {
  const now = new Date('2026-07-14T00:00:00Z');
  const base = {
    userId: 'u1',
    fabFileId: 'f9',
    fileName: 'report.docx',
    currentFilePath: 'files/u1/original_report.docx',
    currentFileSize: 100,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    newFileSize: 120,
    now,
  };

  it('seeds v1 from the pre-edit bytes and appends v2 on the first edit', () => {
    const { newFilePath, versions } = appendEditedVersion(base);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 1, filePath: 'files/u1/original_report.docx', fileSize: 100 });
    expect(versions[1]).toMatchObject({ version: 2, filePath: newFilePath, fileSize: 120 });
    expect(newFilePath).toBe('files/u1/f9/v2_report.docx');
  });

  it('appends onto an existing history without re-seeding', () => {
    const existingVersions = [
      { version: 1, filePath: 'files/u1/original_report.docx', fileSize: 100, mimeType: base.mimeType, createdAt: now },
      { version: 2, filePath: 'files/u1/f9/v2_report.docx', fileSize: 120, mimeType: base.mimeType, createdAt: now },
    ];
    const { newFilePath, versions } = appendEditedVersion({ ...base, existingVersions, newFileSize: 130 });
    expect(versions).toHaveLength(3);
    expect(versions[2]).toMatchObject({ version: 3, filePath: 'files/u1/f9/v3_report.docx', fileSize: 130 });
    expect(newFilePath).toBe('files/u1/f9/v3_report.docx');
  });
});
