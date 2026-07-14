import { describe, it, expect } from 'vitest';
import { nextVersionNumber, versionedFileKey } from './fabfile';

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
