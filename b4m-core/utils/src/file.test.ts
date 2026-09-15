import { describe, it, expect } from 'vitest';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { resolveSupportedMimeType } from './file';

// resolveSupportedMimeType is the shared ingest allow-list gate: it
// decides whether an uploaded file is supported and what MIME type to persist.
// Browsers often report '' or application/octet-stream even for supported
// code/text files, so extension fallback is the crux of the behavior here.
describe('resolveSupportedMimeType', () => {
  it('rejects an unsupported binary with a generic claimed type (.exe)', () => {
    // Reproduces the reported case: guessMimeType/browser yields octet-stream.
    expect(resolveSupportedMimeType('malware.exe', 'application/octet-stream')).toEqual({
      mimeType: '',
      supported: false,
    });
  });

  it('rejects an unsupported binary with no claimed type', () => {
    expect(resolveSupportedMimeType('installer.dll', '').supported).toBe(false);
    expect(resolveSupportedMimeType('archive.zip').supported).toBe(false);
  });

  it('trusts a claimed type that is already supported', () => {
    expect(resolveSupportedMimeType('doc.pdf', SupportedFabFileMimeTypes.PDF)).toEqual({
      mimeType: SupportedFabFileMimeTypes.PDF,
      supported: true,
    });
  });

  it('recovers a supported type from the extension when the claimed type is empty', () => {
    // Browsers frequently report '' for code files; extension must save them.
    expect(resolveSupportedMimeType('main.py', '')).toEqual({
      mimeType: SupportedFabFileMimeTypes.PY,
      supported: true,
    });
    expect(resolveSupportedMimeType('app.ts', undefined)).toEqual({
      mimeType: SupportedFabFileMimeTypes.TS,
      supported: true,
    });
  });

  it('recovers a supported type from the extension when the claimed type is octet-stream', () => {
    expect(resolveSupportedMimeType('data.json', 'application/octet-stream')).toEqual({
      mimeType: SupportedFabFileMimeTypes.JSON,
      supported: true,
    });
  });

  it('recognizes document/image extensions browsers sometimes omit a MIME type for', () => {
    // These were missing from the extension map and would have been wrongly
    // rejected when the browser reported no type.
    expect(resolveSupportedMimeType('deck.pptx', '')).toEqual({
      mimeType: SupportedFabFileMimeTypes.PPTX,
      supported: true,
    });
    expect(resolveSupportedMimeType('logo.svg', '').supported).toBe(true);
    expect(resolveSupportedMimeType('anim.gif', '').supported).toBe(true);
    expect(resolveSupportedMimeType('photo.webp', '').supported).toBe(true);
    expect(resolveSupportedMimeType('data.xml', '').supported).toBe(true);
    expect(resolveSupportedMimeType('photo.jpeg', '')).toEqual({
      mimeType: SupportedFabFileMimeTypes.JPG,
      supported: true,
    });
    expect(resolveSupportedMimeType('readme.mdx', '')).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_MARKDOWN,
      supported: true,
    });
  });

  it('treats config files (ini/env/conf) as supported plain text', () => {
    expect(resolveSupportedMimeType('app.ini', '').supported).toBe(true);
    expect(resolveSupportedMimeType('local.env', '').supported).toBe(true);
    expect(resolveSupportedMimeType('nginx.conf', '').supported).toBe(true);
  });

  it('rejects an extension-less file with no claimed type (batch ingest is strict)', () => {
    // path.extname('Dockerfile') === '' -> no extension -> unsupported here. (The
    // generic single-file path keeps a text/plain fallback for these; the
    // curated bulk-ingest path deliberately does not.)
    expect(resolveSupportedMimeType('Dockerfile', '').supported).toBe(false);
  });
});
