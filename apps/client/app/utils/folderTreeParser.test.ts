import { describe, it, expect } from 'vitest';
import { isSupportedFabFileMimeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import { parseFilesToTree, getAllFiles } from './folderTreeParser';

// parseFilesToTree assigns each file `file.type || guessMimeType(name)`. The
// wizard's unsupported-type gate keys on that resolved type, so these
// tests lock in that supported extensions resolve to a SupportedFabFileMimeType
// while unsupported/binary ones fall through to octet-stream (rejected).
function file(name: string, type = ''): File {
  return new File(['content'], name, { type });
}

function resolvedType(name: string, type = ''): string {
  const tree = parseFilesToTree([file(name, type)], []);
  return getAllFiles(tree)[0].type;
}

describe('folderTreeParser guessMimeType (via parseFilesToTree)', () => {
  it('resolves supported code/text extensions to a supported MIME type when the browser type is empty', () => {
    expect(resolvedType('main.py')).toBe(SupportedFabFileMimeTypes.PY);
    expect(resolvedType('app.ts')).toBe(SupportedFabFileMimeTypes.TS);
    expect(resolvedType('index.js')).toBe(SupportedFabFileMimeTypes.JS);
    expect(resolvedType('config.yaml')).toBe(SupportedFabFileMimeTypes.YAML);
    expect(resolvedType('notes.md')).toBe(SupportedFabFileMimeTypes.TXT_MARKDOWN);

    expect(isSupportedFabFileMimeType(resolvedType('main.py'))).toBe(true);
  });

  it('leaves unsupported/binary types as octet-stream so the wizard gate skips them', () => {
    expect(resolvedType('malware.exe')).toBe('application/octet-stream');
    expect(resolvedType('archive.zip')).toBe('application/octet-stream');
    expect(isSupportedFabFileMimeType(resolvedType('malware.exe'))).toBe(false);
  });

  it('honors a real browser-provided MIME type over the extension guess', () => {
    expect(resolvedType('doc.pdf', 'application/pdf')).toBe(SupportedFabFileMimeTypes.PDF);
  });
});
