import { describe, it, expect } from 'vitest';
import { SupportedFabFileMimeTypes, isStorableFabFileMimeType } from '@bike4mind/common';
import { resolveSupportedMimeType, hasFileExtension, isExtensionlessFileName, getMimeTypeByExtension } from './file';

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

describe('hasFileExtension', () => {
  it.each(['LICENSE', 'Dockerfile', 'Makefile'])('reads dotless name %s as extension-less', name => {
    expect(hasFileExtension(name)).toBe(false);
  });

  it.each(['.env', '.eslintrc', '.prettierrc', '.exe'])('reads dotfile %s as extension-less', name => {
    expect(hasFileExtension(name)).toBe(false);
  });

  it.each(['Meeting notes 2026.09.07', 'My Report v1.2', 'sheet.123'])(
    'treats an all-digit tail as a date/version fragment, not an extension (%s)',
    name => {
      expect(hasFileExtension(name)).toBe(false);
    }
  );

  // The regression this rule exists for: a digit-LED tail is still a real extension.
  it.each(['archive.7z', 'clip.3gp', 'model.3ds'])('reads digit-led tail in %s as a real extension', name => {
    expect(hasFileExtension(name)).toBe(true);
  });

  it.each(['app.properties', 'movie.mkv', 'setup.exe', 'notes.pdf'])('reads %s as having an extension', name => {
    expect(hasFileExtension(name)).toBe(true);
  });

  it('reads a trailing dot as no extension', () => {
    expect(hasFileExtension('payload.')).toBe(false);
  });
});

describe('isExtensionlessFileName', () => {
  it.each(['LICENSE', '.env', 'Meeting notes 2026.09.07'])('accepts %s for the plain-text fallback', name => {
    expect(isExtensionlessFileName(name)).toBe(true);
  });

  // Malformed rather than extension-less, so it gets no fallback on either door.
  it('refuses the fallback to a trailing-dot name', () => {
    expect(isExtensionlessFileName('payload.')).toBe(false);
  });

  it.each(['archive.7z', 'movie.mkv'])('refuses the fallback to %s', name => {
    expect(isExtensionlessFileName(name)).toBe(false);
  });
});

describe('getMimeTypeByExtension', () => {
  // Isolates the invert() last-wins pin from resolveSupportedMimeType's own
  // precedence behavior: the .md cases above all pass a matching claim, so none
  // of them exercise this lookup on its own.
  it('resolves md to the canonical markdown MIME type', () => {
    expect(getMimeTypeByExtension('md')).toBe(SupportedFabFileMimeTypes.TXT_MARKDOWN);
  });
});

describe('resolveSupportedMimeType extension precedence', () => {
  // The spoof: a supported-but-wrong claim must lose to a resolvable extension,
  // or a shell script gets chunked and vectorized as prose.
  it('prefers the extension over a supported but mismatched claim', () => {
    expect(resolveSupportedMimeType('deploy.sh', 'text/plain')).toEqual({
      mimeType: SupportedFabFileMimeTypes.SH,
      supported: true,
    });
  });

  it('still falls back to the claim when the extension resolves to nothing', () => {
    expect(resolveSupportedMimeType('speech.mp3', 'audio/mpeg', { isAcceptable: isStorableFabFileMimeType })).toEqual({
      mimeType: 'audio/mpeg',
      supported: true,
    });
  });

  // Default predicate stays supported-only, so the presign doors that share
  // this helper are not widened to accept audio.
  it('does not accept an audio claim under the default predicate', () => {
    expect(resolveSupportedMimeType('speech.mp3', 'audio/mpeg')).toEqual({
      mimeType: '',
      supported: false,
    });
  });

  it('reports an unresolvable name with an unsupported claim as unsupported', () => {
    expect(resolveSupportedMimeType('archive.7z', 'application/x-7z-compressed')).toEqual({
      mimeType: '',
      supported: false,
    });
  });

  it('resolves .md to the canonical markdown MIME type, not the legacy text/x-markdown spelling', () => {
    expect(resolveSupportedMimeType('notes.md', 'text/markdown')).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_MARKDOWN,
      supported: true,
    });
  });

  it('resolves a dotfile whose tail is itself a real extension (.eslintrc.json)', () => {
    expect(resolveSupportedMimeType('.eslintrc.json', undefined)).toEqual({
      mimeType: SupportedFabFileMimeTypes.JSON,
      supported: true,
    });
  });

  it('does not throw on an explicit null claimed type and reports unsupported', () => {
    expect(resolveSupportedMimeType('LICENSE', null)).toEqual({ mimeType: '', supported: false });
  });

  // The extension resolves to nothing here, so this only passes if the claim
  // fallback fires under the default (isSupportedFabFileMimeType) predicate -
  // proving that branch is reachable, not just the isStorableFabFileMimeType path
  // exercised above.
  it('reaches a supported type through the claim path alone under the default predicate', () => {
    expect(resolveSupportedMimeType('notes.unknownext', SupportedFabFileMimeTypes.HTML)).toEqual({
      mimeType: SupportedFabFileMimeTypes.HTML,
      supported: true,
    });
  });
});

// Precedence is per-caller: a door whose claim comes from a trusted server-side
// source (e.g. Google Drive's stored metadata) picks claim-first, since the
// filename there is the free-form, user-renamable part.
describe('resolveSupportedMimeType precedence option', () => {
  it('claim-first prefers a supported claim over a resolvable, different extension', () => {
    expect(resolveSupportedMimeType('summary.txt', 'application/pdf', { precedence: 'claim-first' })).toEqual({
      mimeType: SupportedFabFileMimeTypes.PDF,
      supported: true,
    });
  });

  it('claim-first falls back to the extension when the claim is absent', () => {
    expect(resolveSupportedMimeType('summary.txt', undefined, { precedence: 'claim-first' })).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
      supported: true,
    });
  });

  it('claim-first falls back to the extension when the claim is unsupported', () => {
    expect(
      resolveSupportedMimeType('summary.txt', 'application/x-7z-compressed', { precedence: 'claim-first' })
    ).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
      supported: true,
    });
  });

  it('extension-first (the default) is unchanged by the precedence parameter', () => {
    expect(resolveSupportedMimeType('deploy.sh', 'text/plain', { precedence: 'extension-first' })).toEqual({
      mimeType: SupportedFabFileMimeTypes.SH,
      supported: true,
    });
  });

  it('composes precedence with a custom isAcceptable predicate', () => {
    expect(
      resolveSupportedMimeType('speech.mp3', 'audio/mpeg', {
        isAcceptable: isStorableFabFileMimeType,
        precedence: 'claim-first',
      })
    ).toEqual({
      mimeType: 'audio/mpeg',
      supported: true,
    });
  });
});

// The extension-less rule lives in the resolver rather than at each door, so LICENSE
// resolves the same way whichever ingest door it arrives at. It stays opt-in: a door
// that omits it (the presigned-URL routes, the curated bulk path) keeps refusing.
describe('resolveSupportedMimeType extensionlessFallback option', () => {
  const opts = { extensionlessFallback: SupportedFabFileMimeTypes.TXT_PLAIN };

  it.each(['LICENSE', '.env', 'Meeting notes 2026.09.07'])('falls back to plain text for %s', name => {
    expect(resolveSupportedMimeType(name, '', opts)).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
      supported: true,
    });
  });

  // The fallback must not become a route around the rejection: a claim that was supplied
  // and refused stays refused, extension-less name or not.
  it('refuses an extension-less name whose supplied claim is unsupported', () => {
    expect(resolveSupportedMimeType('payload', 'application/octet-stream', opts)).toEqual({
      mimeType: '',
      supported: false,
    });
  });

  it.each(['archive.7z', 'payload.'])('refuses %s rather than falling back', name => {
    expect(resolveSupportedMimeType(name, '', opts)).toEqual({ mimeType: '', supported: false });
  });

  it('keeps refusing an extension-less name when the option is omitted', () => {
    expect(resolveSupportedMimeType('LICENSE', '')).toEqual({ mimeType: '', supported: false });
  });

  it('honours a supported claim ahead of the fallback', () => {
    expect(resolveSupportedMimeType('LICENSE', SupportedFabFileMimeTypes.PDF, opts)).toEqual({
      mimeType: SupportedFabFileMimeTypes.PDF,
      supported: true,
    });
  });
});
