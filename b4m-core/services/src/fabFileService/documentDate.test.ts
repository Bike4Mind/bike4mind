import { describe, expect, it } from 'vitest';
import { DocumentDateSource, FabFileSourceType } from '@bike4mind/common';
import { resolveDocumentDate, resolveDocumentDateWithoutContent } from './documentDate';

const driveCreated = new Date('2019-04-01T00:00:00Z');
const extracted = { date: new Date('2021-06-15T00:00:00Z'), source: DocumentDateSource.PDF_METADATA };

describe('resolveDocumentDate', () => {
  it('takes the extracted date for an ordinary upload', () => {
    expect(resolveDocumentDate({ sourceType: FabFileSourceType.MANUAL_UPLOAD }, extracted)).toEqual({
      documentDate: extracted.date,
      documentDateSource: extracted.source,
    });
  });

  it('clears a previously stored date when the bytes offer none', () => {
    const file = {
      sourceType: FabFileSourceType.MANUAL_UPLOAD,
      documentDate: new Date('2020-01-01T00:00:00Z'),
      documentDateSource: DocumentDateSource.FRONTMATTER,
    };
    expect(resolveDocumentDate(file, undefined)).toEqual({ documentDate: null, documentDateSource: null });
  });

  it('keeps a pinned DRIVE_CREATED vintage over the rendition date', () => {
    const file = {
      sourceType: FabFileSourceType.GOOGLE_DRIVE,
      documentDate: driveCreated,
      documentDateSource: DocumentDateSource.DRIVE_CREATED,
    };
    expect(resolveDocumentDate(file, extracted)).toEqual({
      documentDate: driveCreated,
      documentDateSource: DocumentDateSource.DRIVE_CREATED,
    });
  });

  it('does not treat a dateless DRIVE_CREATED source as a pin', () => {
    const file = {
      sourceType: FabFileSourceType.GOOGLE_DRIVE,
      driveMd5Checksum: 'abc123',
      documentDate: null,
      documentDateSource: DocumentDateSource.DRIVE_CREATED,
    };
    expect(resolveDocumentDate(file, extracted)).toEqual({
      documentDate: extracted.date,
      documentDateSource: extracted.source,
    });
  });

  it('nulls an unpinned Drive Editors file rather than trusting its export rendition', () => {
    expect(resolveDocumentDate({ sourceType: FabFileSourceType.GOOGLE_DRIVE }, extracted)).toEqual({
      documentDate: null,
      documentDateSource: null,
    });
  });

  it('trusts the bytes of a native binary uploaded to Drive', () => {
    const file = { sourceType: FabFileSourceType.GOOGLE_DRIVE, driveMd5Checksum: 'abc123' };
    expect(resolveDocumentDate(file, extracted)).toEqual({
      documentDate: extracted.date,
      documentDateSource: extracted.source,
    });
  });
});

describe('resolveDocumentDateWithoutContent', () => {
  it('defers to the bytes whenever they can change the answer', () => {
    expect(resolveDocumentDateWithoutContent({ sourceType: FabFileSourceType.MANUAL_UPLOAD })).toBeUndefined();
    expect(
      resolveDocumentDateWithoutContent({ sourceType: FabFileSourceType.GOOGLE_DRIVE, driveMd5Checksum: 'abc123' })
    ).toBeUndefined();
  });
});
