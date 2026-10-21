import { describe, it, expect, vi } from 'vitest';
import { AI_EDIT_VERSION_RETENTION_DEFAULT, SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { BaseStorage } from '@bike4mind/fab-pipeline';
import type { Logger } from '@bike4mind/observability';

const mockAxiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: mockAxiosGet } }));

import {
  appendEditedVersion,
  trimVersionHistory,
  computeContentHash,
  getFileContent,
  nextVersionNumber,
  versionedFileKey,
} from './fabfile';

/** A one-page PDF reading `text`, with a correct xref table so pdf.js parses it without repair. */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('computeContentHash', () => {
  it('is sha256 hex, independent of whether the input is a string or an equivalent Buffer', () => {
    // Computed independently rather than trusted from the implementation.
    const expected = 'd9fbbc91492fbb3ba8e57ca15b039134e7098030a89578315a4c354f9117ccf2';
    expect(computeContentHash('body text')).toBe(expected);
    expect(computeContentHash(Buffer.from('body text'))).toBe(expected);
  });

  it('is deterministic and sensitive to every byte, so a single differing byte changes the hash', () => {
    expect(computeContentHash('same input')).toBe(computeContentHash('same input'));
    expect(computeContentHash('same input')).not.toBe(computeContentHash('same inpuT'));
  });
});

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
  it('namespaces by user and file, includes the nonce, and preserves the original file name', () => {
    expect(versionedFileKey({ userId: 'u1', fabFileId: 'f9', fileName: 'report.docx', version: 2, nonce: 'abc' })).toBe(
      'files/u1/f9/v2_abc_report.docx'
    );
  });

  it('gives concurrent same-version edits distinct keys via the nonce', () => {
    const base = { userId: 'u1', fabFileId: 'f9', fileName: 'report.docx', version: 3 };
    expect(versionedFileKey({ ...base, nonce: 'n1' })).not.toBe(versionedFileKey({ ...base, nonce: 'n2' }));
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
    nonce: 'abc',
    maxEditedVersions: 10,
  };

  it('seeds v1 from the pre-edit bytes and appends v2 on the first edit', () => {
    const { newFilePath, versions } = appendEditedVersion(base);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 1, filePath: 'files/u1/original_report.docx', fileSize: 100 });
    expect(versions[1]).toMatchObject({ version: 2, filePath: newFilePath, fileSize: 120 });
    expect(newFilePath).toBe('files/u1/f9/v2_abc_report.docx');
  });

  it('appends onto an existing history without re-seeding', () => {
    const existingVersions = [
      { version: 1, filePath: 'files/u1/original_report.docx', fileSize: 100, mimeType: base.mimeType, createdAt: now },
      { version: 2, filePath: 'files/u1/f9/v2_report.docx', fileSize: 120, mimeType: base.mimeType, createdAt: now },
    ];
    const { newFilePath, versions } = appendEditedVersion({ ...base, existingVersions, newFileSize: 130 });
    expect(versions).toHaveLength(3);
    expect(versions[2]).toMatchObject({ version: 3, filePath: 'files/u1/f9/v3_abc_report.docx', fileSize: 130 });
    expect(newFilePath).toBe('files/u1/f9/v3_abc_report.docx');
  });

  const historyOf = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      version: i + 1,
      filePath: i === 0 ? 'files/u1/original_report.docx' : `files/u1/f9/v${i + 1}_report.docx`,
      fileSize: 100,
      mimeType: base.mimeType,
      createdAt: now,
    }));

  it('drops nothing while under or exactly at the cap', () => {
    // 1 + 2 existing, +1 new = v1 + 3 edited, cap 3
    const under = appendEditedVersion({ ...base, existingVersions: historyOf(2), maxEditedVersions: 3 });
    expect(under.versions).toHaveLength(3);
    expect(under.droppedVersions).toEqual([]);
    const atCap = appendEditedVersion({ ...base, existingVersions: historyOf(3), maxEditedVersions: 3 });
    expect(atCap.versions.map(v => v.version)).toEqual([1, 2, 3, 4]);
    expect(atCap.droppedVersions).toEqual([]);
  });

  it('caps at the default retention when maxEditedVersions is omitted', () => {
    const { maxEditedVersions: _omitted, ...withoutCap } = base;
    const { versions, droppedVersions } = appendEditedVersion({
      ...withoutCap,
      existingVersions: historyOf(AI_EDIT_VERSION_RETENTION_DEFAULT + 3),
    });
    expect(versions).toHaveLength(AI_EDIT_VERSION_RETENTION_DEFAULT + 1);
    expect(droppedVersions).toHaveLength(3);
  });

  it('keeps v1 plus the last N edited versions and reports the dropped ones', () => {
    const { newFilePath, versions, droppedVersions } = appendEditedVersion({
      ...base,
      existingVersions: historyOf(5),
      maxEditedVersions: 3,
    });
    expect(versions.map(v => v.version)).toEqual([1, 4, 5, 6]);
    expect(versions[versions.length - 1].filePath).toBe(newFilePath);
    expect(droppedVersions.map(v => v.filePath)).toEqual(['files/u1/f9/v2_report.docx', 'files/u1/f9/v3_report.docx']);
  });

  it('with N=1 keeps only v1 and the new version', () => {
    const first = appendEditedVersion({ ...base, maxEditedVersions: 1 });
    expect(first.versions.map(v => v.version)).toEqual([1, 2]);
    expect(first.droppedVersions).toEqual([]);
    const next = appendEditedVersion({ ...base, existingVersions: first.versions, maxEditedVersions: 1 });
    expect(next.versions.map(v => v.version)).toEqual([1, 3]);
    expect(next.droppedVersions.map(v => v.version)).toEqual([2]);
  });
});

describe('trimVersionHistory', () => {
  const v = (version: number, filePath: string) => ({
    version,
    filePath,
    fileSize: 1,
    mimeType: 'x',
    createdAt: new Date(0),
  });

  it('never reports a dropped entry whose key a retained entry still holds', () => {
    const { versions, droppedVersions } = trimVersionHistory([v(1, 'a'), v(2, 'a'), v(3, ''), v(4, 'b'), v(5, 'c')], 2);
    expect(versions.map(x => x.version)).toEqual([1, 4, 5]);
    expect(droppedVersions).toEqual([]);
  });

  it('treats a non-positive cap as 1', () => {
    expect(trimVersionHistory([v(1, 'a'), v(2, 'b'), v(3, 'c')], 0).versions.map(x => x.version)).toEqual([1, 3]);
  });
});

describe('getFileContent PDF extraction', () => {
  const storage = {
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/file.pdf'),
  } as unknown as BaseStorage;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger;
  const pdfFile = { fileName: 'invoice.pdf', filePath: 'k.pdf', mimeType: SupportedFabFileMimeTypes.PDF };

  it("extracts a PDF small enough to live in Node's shared Buffer pool", async () => {
    // axios hands back a Buffer in Node. One this small is a view into the shared pool, whose
    // backing ArrayBuffer pdf.js cannot transfer - the read used to throw DataCloneError here.
    const pdf = tinyPdf('Invoice total 42');
    expect(pdf.length).toBeLessThan(Buffer.poolSize >>> 1);
    mockAxiosGet.mockResolvedValue({ data: pdf });

    await expect(getFileContent(pdfFile, { storage, logger })).resolves.toContain('Invoice total 42');
  });
});
