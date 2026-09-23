import { describe, it, expect } from 'vitest';
import { CurationArtifactType, type CurationOptions } from '@bike4mind/common';
import { extractArtifactsFromMessage, mapMimeTypeToArtifactType, type CurationMessage } from './artifactExtractor';

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
  } as CurationOptions;

  it('keeps an apostrophe inside a double-quoted title', () => {
    const artifacts = extractArtifactsFromMessage(
      {
        id: 'm1',
        reply: `<artifact identifier="bobs-app" type="text/html" title="Bob's App"><p>hi</p></artifact>`,
      } as CurationMessage,
      options
    );
    const html = artifacts.find(a => a.type === CurationArtifactType.HTML);
    expect(html?.metadata?.title).toBe("Bob's App");
  });
});

describe('extractArtifactsFromMessage - presentation-only fences', () => {
  const options = {
    includeCode: true,
    includeDiagrams: true,
    includeDataViz: true,
  } as CurationOptions;

  const reply = [
    'Here are the ones worth looking at.',
    '',
    '```b4m_cards',
    '{"cards":[',
    '{"name":"A","images":["https://cdn.example.com/a.jpg"]}',
    ']}',
    '```',
    '',
    'The first is the safest pick.',
  ].join('\n');

  it('does not curate a b4m_cards block as a code artifact', () => {
    const artifacts = extractArtifactsFromMessage({ id: 'm1', reply } as CurationMessage, options);

    expect(artifacts).toEqual([]);
  });

  it('still curates an ordinary code fence in the same reply', () => {
    const withCode = `${reply}\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n\`\`\``;

    const artifacts = extractArtifactsFromMessage({ id: 'm1', reply: withCode } as CurationMessage, options);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: CurationArtifactType.CODE, language: 'ts' });
  });
});
