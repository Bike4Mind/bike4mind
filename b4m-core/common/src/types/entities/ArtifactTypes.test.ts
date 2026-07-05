import { describe, it, expect } from 'vitest';
import { ClaudeArtifactMimeTypes, mapMimeTypeToArtifactType } from './ArtifactTypes';

describe('mapMimeTypeToArtifactType — single source of truth (#8907)', () => {
  it('maps each blessed Claude MIME type to its internal artifact type', () => {
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.REACT)).toBe('react');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.HTML)).toBe('html');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.SVG)).toBe('svg');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.MERMAID)).toBe('mermaid');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.RECHARTS)).toBe('recharts');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.CHESS)).toBe('chess');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.CODE)).toBe('code');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.PYTHON)).toBe('python');
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.BLOG_DRAFT)).toBe('blog-draft');
  });

  it('treats markdown as code', () => {
    expect(mapMimeTypeToArtifactType(ClaudeArtifactMimeTypes.MARKDOWN)).toBe('code');
  });

  it('maps the b4m-namespaced lattice MIME — the drift that caused the #8905 dedup bug', () => {
    // The lattice tool emits application/vnd.b4m.lattice (not vnd.ant.lattice). A stale copy
    // matched the ant. string, letting lattice tool_result artifacts dodge the dedup set.
    expect(ClaudeArtifactMimeTypes.LATTICE).toBe('application/vnd.b4m.lattice');
    expect(mapMimeTypeToArtifactType('application/vnd.b4m.lattice')).toBe('lattice');
    // The incorrect ant.-namespaced string must NOT silently map to lattice.
    expect(mapMimeTypeToArtifactType('application/vnd.ant.lattice')).toBeNull();
  });

  it('is case-insensitive (MIME types are)', () => {
    expect(mapMimeTypeToArtifactType('TEXT/HTML')).toBe('html');
    expect(mapMimeTypeToArtifactType('  Application/Vnd.Ant.React  ')).toBe('react');
  });

  it('infers from language/format strings when not an exact match', () => {
    expect(mapMimeTypeToArtifactType('text/jsx')).toBe('react');
    expect(mapMimeTypeToArtifactType('text/javascript')).toBe('code'); // plain JS is code, not react
    expect(mapMimeTypeToArtifactType('text/x-python')).toBe('python');
    expect(mapMimeTypeToArtifactType('application/x-mermaid')).toBe('mermaid');
    expect(mapMimeTypeToArtifactType('text/x-rust')).toBe('code');
  });

  it('returns null for unknown / empty types', () => {
    expect(mapMimeTypeToArtifactType('application/octet-stream')).toBeNull();
    expect(mapMimeTypeToArtifactType('')).toBeNull();
  });

  it('returns null (does not throw) for null/undefined — call sites cast untyped metadata', () => {
    expect(mapMimeTypeToArtifactType(undefined)).toBeNull();
    expect(mapMimeTypeToArtifactType(null)).toBeNull();
  });
});
