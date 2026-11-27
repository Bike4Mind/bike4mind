import { describe, it, expect } from 'vitest';
import { localPreviewKind } from './LocalFilePreview';

describe('localPreviewKind', () => {
  it.each([
    ['photo.png', 'image/png', 'image'],
    ['report.pdf', 'application/pdf', 'pdf'],
    ['clip.mov', 'video/quicktime', 'video'],
    ['notes.md', 'text/markdown', 'text'],
    ['data.json', 'application/json', 'text'],
    ['main.rs', '', 'text'],
    ['page.HTML', 'application/octet-stream', 'text'],
    ['contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', null],
    ['archive.zip', 'application/zip', null],
  ])('%s (%s) -> %s', (fileName, mimeType, kind) => {
    expect(localPreviewKind({ fileName, mimeType })).toBe(kind);
  });
});
