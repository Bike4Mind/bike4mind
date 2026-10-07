import { describe, it, expect } from 'vitest';
import { SupportedFabFileMimeTypes, isStorableFabFileMimeType } from '@bike4mind/common';
import { resolveSupportedMimeType, getMimeTypeByExtension } from './file';

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

  // Regression: the Mermaid preview card's "Save as file" upload sent
  // `<name>_<ts>.mmd` as text/plain and was refused outright because `.mmd` was
  // missing from the extension table (BadRequestError "File type .mmd is not
  // supported"), even though the claimed type was already a supported one.
  it('accepts a Mermaid diagram source file (.mmd) claimed as text/plain', () => {
    expect(resolveSupportedMimeType('diagram_123.mmd', 'text/plain')).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
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

// The extension/extension-less rule is module-private, so it is pinned through the resolver:
// only a name carrying no extension at all earns a door's plain-text fallback.
describe('resolveSupportedMimeType extension-less rule', () => {
  const opts = { extensionlessFallback: SupportedFabFileMimeTypes.TXT_PLAIN };

  it.each(['LICENSE', 'Dockerfile', 'Makefile'])('reads dotless name %s as extension-less', name => {
    expect(resolveSupportedMimeType(name, '', opts)).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
      supported: true,
    });
  });

  it.each(['.env', '.eslintrc', '.prettierrc'])('reads dotfile %s as extension-less', name => {
    expect(resolveSupportedMimeType(name, '', opts)).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
      supported: true,
    });
  });

  // `.exe` resolves the same way - `path.extname('.exe')` is also '' for a leading-dot-only
  // name, so it takes the same plain-text fallback as the dotfiles above. Not a regression
  // (main reaches the same outcome); stated on its own because it deliberately includes a
  // name whose tail happens to look like a binary extension. Checking the tail against the
  // extension table would not catch it either, since '.exe' resolves to nothing here - the
  // asymmetry is the point: 'backup.001' is refused above while '.exe' is admitted.
  it('reads .exe as extension-less too, and admits it via the same fallback', () => {
    expect(resolveSupportedMimeType('.exe', '', opts)).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
      supported: true,
    });
  });

  // A digit tail used to be exempted as a date/version fragment, which let any binary in under a
  // rename ('payload.1'). A dot-tail is an extension like any other now: resolve or be refused.
  it.each(['Meeting notes 2026.09.07', 'My Report v1.2', 'sheet.123', 'payload.1', 'backup.001', 'disk.386'])(
    'refuses digit-tail name %s rather than falling back to plain text',
    name => {
      expect(resolveSupportedMimeType(name, '', opts)).toEqual({ mimeType: '', supported: false });
    }
  );

  it.each(['archive.7z', 'clip.3gp', 'model.3ds'])('refuses digit-led tail in %s', name => {
    expect(resolveSupportedMimeType(name, '', opts)).toEqual({ mimeType: '', supported: false });
  });

  it.each(['app.properties', 'movie.mkv', 'setup.exe'])('refuses unresolvable extension in %s', name => {
    expect(resolveSupportedMimeType(name, '', opts)).toEqual({ mimeType: '', supported: false });
  });

  it('still resolves a known extension when the fallback is offered', () => {
    expect(resolveSupportedMimeType('notes.pdf', '', opts)).toEqual({
      mimeType: SupportedFabFileMimeTypes.PDF,
      supported: true,
    });
  });

  // Malformed rather than extension-less, so it gets no fallback on either door.
  it('refuses the fallback to a trailing-dot name', () => {
    expect(resolveSupportedMimeType('payload.', '', opts)).toEqual({ mimeType: '', supported: false });
  });
});

describe('getMimeTypeByExtension', () => {
  // Pins the canonical spelling: md must resolve to TXT_MARKDOWN, not the legacy
  // text/x-markdown enum member. The .md cases above all pass a matching claim, so
  // none of them exercise this lookup on its own.
  it('resolves md to the canonical markdown MIME type', () => {
    expect(getMimeTypeByExtension('md')).toBe(SupportedFabFileMimeTypes.TXT_MARKDOWN);
  });

  // log/yml/htm are in the client's own map (guessMimeType in
  // apps/client/app/utils/folderTreeParser.ts); an extension-first door would refuse them
  // outright without an entry in the extension table.
  //
  // jfif/jpe/text/shtml are different: browser-reported spellings with no client-side
  // counterpart in guessMimeType - keep them here even though nothing on the client ever
  // produces them, or a browser's own claim for one of these fails the extension-first
  // check that backs it up.
  it.each([
    ['log', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['yml', SupportedFabFileMimeTypes.YAML],
    ['htm', SupportedFabFileMimeTypes.HTML],
    ['jfif', SupportedFabFileMimeTypes.JPG],
    ['jpe', SupportedFabFileMimeTypes.JPG],
    ['text', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['shtml', SupportedFabFileMimeTypes.HTML],
  ])('resolves %s to its alias MIME type', (ext, mime) => {
    expect(getMimeTypeByExtension(ext)).toBe(mime);
  });

  // Regression pin from an earlier refactor: every extension the old if-branch
  // implementation resolved still resolves the same way today.
  it.each([
    ['xls', SupportedFabFileMimeTypes.XLS],
    ['xlsx', SupportedFabFileMimeTypes.XLSX],
    ['docx', SupportedFabFileMimeTypes.DOCX],
    ['pptx', SupportedFabFileMimeTypes.PPTX],
    ['ts', SupportedFabFileMimeTypes.TS],
    ['tsx', SupportedFabFileMimeTypes.TS],
    ['jpeg', SupportedFabFileMimeTypes.JPG],
    ['ini', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['env', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['conf', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['mdx', SupportedFabFileMimeTypes.TXT_MARKDOWN],
  ])('still resolves %s to its prior MIME type', (ext, mime) => {
    expect(getMimeTypeByExtension(ext)).toBe(mime);
  });

  // Plainly-textual source extensions with no client-side entry behind them. The claim used
  // to carry these in; under extension-first the table has to, or an API caller sending
  // 'text/plain' for a .sql file is refused.
  it.each([
    ['sql', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['mjs', SupportedFabFileMimeTypes.JS],
    ['cjs', SupportedFabFileMimeTypes.JS],
    ['c', SupportedFabFileMimeTypes.CPP],
    ['h', SupportedFabFileMimeTypes.CPP],
  ])('resolves source extension %s', (ext, mime) => {
    expect(getMimeTypeByExtension(ext)).toBe(mime);
  });

  // A prototype-bearing lookup table answers these with an inherited member (the Object
  // function itself), which is truthy and so escapes as a non-string mimeType.
  it.each(['constructor', '__proto__', 'toString'])('resolves inherited key %s to nothing', key => {
    expect(getMimeTypeByExtension(key)).toBe('');
  });
});

// Pins the client/server allowlist agreement: these extensions are in the client's
// guessMimeType map and must resolve (not be refused) at a default extension-first door.
describe('resolveSupportedMimeType extension-alias regression', () => {
  it.each([
    ['notes.yml', SupportedFabFileMimeTypes.YAML],
    ['app.log', SupportedFabFileMimeTypes.TXT_PLAIN],
    ['page.htm', SupportedFabFileMimeTypes.HTML],
  ])('accepts %s with a matching claim at the default door', (name, mime) => {
    expect(resolveSupportedMimeType(name, mime)).toEqual({
      mimeType: mime,
      supported: true,
    });
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

  // An extension we cannot resolve is the loophole this door exists to close: a supported claim
  // must not rescue it, or any binary is admitted under a renamed-away extension.
  it.each([
    ['malware.exe', 'text/plain'],
    ['archive.rar', 'application/pdf'],
    ['notes.unknownext', SupportedFabFileMimeTypes.HTML],
  ])('refuses %s even though it claims the supported type %s', (name, claim) => {
    expect(resolveSupportedMimeType(name, claim)).toEqual({ mimeType: '', supported: false });
  });

  // Audio resolves by extension now (the extension table carries the audio types), so the
  // predicate is the only thing deciding it - the claim is never reached.
  it('keeps audio supported under the storable predicate', () => {
    expect(resolveSupportedMimeType('speech.mp3', 'audio/mpeg', { isAcceptable: isStorableFabFileMimeType })).toEqual({
      mimeType: 'audio/mpeg',
      supported: true,
    });
    expect(resolveSupportedMimeType('speech.mp3', undefined, { isAcceptable: isStorableFabFileMimeType })).toEqual({
      mimeType: 'audio/mpeg',
      supported: true,
    });
  });

  // Default predicate stays supported-only, so the presign doors that share
  // this helper are not widened to accept audio.
  it('does not accept an audio claim under the default predicate', () => {
    expect(resolveSupportedMimeType('speech.mp3', 'audio/mpeg')).toEqual({
      mimeType: 'audio/mpeg',
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

  // Under extension-first the claim is only consulted for a name carrying no extension at all;
  // an unresolvable extension is refused above rather than handed to the claim.
  it('reaches a supported type through the claim path alone under the default predicate', () => {
    expect(resolveSupportedMimeType('LICENSE', SupportedFabFileMimeTypes.HTML)).toEqual({
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

  // What copy-generated-image relies on: a trusted claim keeps its type whatever the caller
  // named the file.
  it('claim-first keeps a trusted image claim over a mismatched name', () => {
    expect(resolveSupportedMimeType('notes.txt', 'image/png', { precedence: 'claim-first' })).toEqual({
      mimeType: SupportedFabFileMimeTypes.PNG,
      supported: true,
    });
  });

  // And the hazard it guards at the door: a generic claim is not acceptable, so claim-first
  // silently falls through to the filename - which is why that route maps octet-stream to PNG
  // before calling in rather than passing it on.
  it('claim-first falls through to the filename when the claim is a generic octet-stream', () => {
    expect(resolveSupportedMimeType('notes.txt', 'application/octet-stream', { precedence: 'claim-first' })).toEqual({
      mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
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

// Which names earn the fallback is pinned by the 'extension-less rule' block above; this
// block covers the option itself - that it stays opt-in (a door omitting it keeps refusing),
// and that it never outranks a supplied claim.
describe('resolveSupportedMimeType extensionlessFallback option', () => {
  const opts = { extensionlessFallback: SupportedFabFileMimeTypes.TXT_PLAIN };

  // The fallback must not become a route around the rejection: a claim that was supplied
  // and refused stays refused, extension-less name or not.
  it('refuses an extension-less name whose supplied claim is unsupported', () => {
    expect(resolveSupportedMimeType('payload', 'application/octet-stream', opts)).toEqual({
      mimeType: '',
      supported: false,
    });
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
