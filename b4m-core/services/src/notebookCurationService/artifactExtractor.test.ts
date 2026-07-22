import { describe, it, expect } from 'vitest';
import { CurationArtifactType } from '@bike4mind/common';
import { extractArtifactsFromMessage, mapMimeTypeToArtifactType } from './artifactExtractor';

// The curation extractor used to carry its own copy of the MIME-to-type table. It now
// delegates parsing to the shared @bike4mind/common mapper and only bridges the shared
// string-union result to the CurationArtifactType enum. These tests lock that bridge.
describe('mapMimeTypeToArtifactType (curation bridge)', () => {
  it('maps blessed MIME types to their CurationArtifactType', () => {
    expect(mapMimeTypeToArtifactType('application/vnd.ant.react')).toBe(CurationArtifactType.REACT);
    expect(mapMimeTypeToArtifactType('text/html')).toBe(CurationArtifactType.HTML);
    expect(mapMimeTypeToArtifactType('image/svg+xml')).toBe(CurationArtifactType.SVG);
    expect(mapMimeTypeToArtifactType('application/vnd.ant.mermaid')).toBe(CurationArtifactType.MERMAID);
    expect(mapMimeTypeToArtifactType('application/vnd.ant.recharts')).toBe(CurationArtifactType.RECHARTS);
    expect(mapMimeTypeToArtifactType('application/vnd.ant.code')).toBe(CurationArtifactType.CODE);
  });

  it('collapses python and language code MIME types to CODE', () => {
    // curation has no dedicated python type - it lives under CODE
    expect(mapMimeTypeToArtifactType('text/x-python')).toBe(CurationArtifactType.CODE);
    expect(mapMimeTypeToArtifactType('text/x.python')).toBe(CurationArtifactType.CODE);
    // js/ts resolve to CODE via the shared mapper's includes() inference, not an exact MIME
    // match - pin them so a future narrowing of that inference can't silently regress curation.
    expect(mapMimeTypeToArtifactType('text/x.javascript')).toBe(CurationArtifactType.CODE);
    expect(mapMimeTypeToArtifactType('text/x.typescript')).toBe(CurationArtifactType.CODE);
  });

  it('returns null for types the shared mapper recognizes but curation does not model', () => {
    // These MUST be the canonical vendor strings the shared mapper actually keys on
    // (application/vnd.b4m.* / vnd.ant.chess, ArtifactTypes.ts) - otherwise the assertion
    // passes trivially via the unknown->null path and never exercises the bridge's default branch.
    expect(mapMimeTypeToArtifactType('application/vnd.b4m.lattice')).toBeNull(); // shared -> 'lattice'
    expect(mapMimeTypeToArtifactType('application/vnd.b4m.blog-draft')).toBeNull(); // shared -> 'blog-draft'
    expect(mapMimeTypeToArtifactType('application/vnd.ant.chess')).toBeNull(); // shared -> 'chess'
  });

  it('returns null for unknown / unmappable MIME types', () => {
    expect(mapMimeTypeToArtifactType('application/octet-stream')).toBeNull();
    expect(mapMimeTypeToArtifactType('')).toBeNull();
  });
});

/**
 * ATTRIBUTE_REGEX used to stop the value capture at the first quote of either kind,
 * so a double-quoted attribute containing an apostrophe was silently truncated.
 */
describe('extractArtifactsFromMessage - attribute values containing quotes', () => {
  const options = {
    includeCode: true,
    includeDiagrams: true,
    includeDataViz: true,
  } as Parameters<typeof extractArtifactsFromMessage>[1];

  it('keeps an apostrophe inside a double-quoted title', () => {
    const artifacts = extractArtifactsFromMessage(
      {
        id: 'm1',
        reply: `<artifact identifier="bobs-app" type="text/html" title="Bob's App"><p>hi</p></artifact>`,
      },
      options
    );
    const html = artifacts.find(a => a.type === CurationArtifactType.HTML);
    expect(html?.metadata?.title).toBe("Bob's App");
  });
});
