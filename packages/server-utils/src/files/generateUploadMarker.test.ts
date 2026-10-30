import { describe, it, expect } from 'vitest';
import { GENERATE_UPLOAD_MARKER, isOwnedGenerateUpload } from './generateUploadMarker';

// `deletedAt: null` is what the soft-delete plugin returns for a live document, not an absent key.
const marked = (extra: Record<string, unknown> = {}) => ({
  userId: 'u1',
  deletedAt: null,
  sourceMetadata: { uploadedVia: GENERATE_UPLOAD_MARKER },
  ...extra,
});

describe('isOwnedGenerateUpload', () => {
  it('accepts an own, live, marked file', () => {
    expect(isOwnedGenerateUpload(marked(), 'u1')).toBe(true);
  });

  it('compares owners as strings, so an ObjectId-shaped userId matches', () => {
    expect(isOwnedGenerateUpload(marked({ userId: { toString: () => 'u1' } }), 'u1')).toBe(true);
  });

  it.each([
    ['a foreign owner', marked({ userId: 'u2' })],
    ['no marker', marked({ sourceMetadata: undefined })],
    ['a different uploadedVia value', marked({ sourceMetadata: { uploadedVia: 'paste' } })],
    ['a soft-deleted file', marked({ deletedAt: new Date() })],
  ])('rejects %s', (_name, file) => {
    expect(isOwnedGenerateUpload(file, 'u1')).toBe(false);
  });

  it('rejects a missing file', () => {
    expect(isOwnedGenerateUpload(null, 'u1')).toBe(false);
    expect(isOwnedGenerateUpload(undefined, 'u1')).toBe(false);
  });
});
