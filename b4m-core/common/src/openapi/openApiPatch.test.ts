import { describe, expect, it } from 'vitest';
import { applyOpenApiPatch, diffOpenApiDocument } from './openApiPatch';

const base = {
  openapi: '3.1.0',
  info: { title: 'T', description: 'core' },
  paths: { '/a': { get: { id: 'a' } }, '/b': { get: { id: 'b' } } },
  components: { schemas: { A: { type: 'object' }, B: { type: 'string' } } },
  tags: [{ name: 'x' }],
};

describe('openApiPatch', () => {
  it('round-trips additions, replacements and removals byte for byte, including key order', () => {
    const next = {
      openapi: '3.1.0',
      info: { title: 'T', description: 'deployment' },
      paths: { '/c': { get: { id: 'c' } }, '/a': { get: { id: 'a2' } } },
      components: { schemas: { A: { type: 'object' }, C: { type: 'number' }, B: { type: 'string' } } },
      tags: [{ name: 'x' }, { name: 'y' }],
    };
    const applied = applyOpenApiPatch(base, diffOpenApiDocument(base, next));
    expect(JSON.stringify(applied)).toBe(JSON.stringify(next));
  });

  it('carries only what differs, not the shared content', () => {
    const next = { ...base, paths: { ...base.paths, '/c': { get: { id: 'c' } } } };
    const patch = diffOpenApiDocument(base, next);
    expect(Object.keys(patch.set ?? {})).toEqual([]);
    expect(patch.nested?.paths?.set).toEqual({ '/c': { get: { id: 'c' } } });
    expect(patch.nested?.components).toBeUndefined();
  });

  it('does not mutate the base document', () => {
    const snapshot = JSON.stringify(base);
    applyOpenApiPatch(base, diffOpenApiDocument(base, { ...base, info: { title: 'Z' } }));
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('fails loudly when the base lacks a key the patch relies on', () => {
    const patch = diffOpenApiDocument(base, base);
    expect(() => applyOpenApiPatch({ openapi: '3.1.0' }, patch)).toThrow(/expects "info"/);
  });

  it('treats keys that collide with Object.prototype as ordinary keys', () => {
    const withProtoKeys = JSON.parse('{"s":{"toString":{"t":1},"B":1}}') as Record<string, unknown>;
    const next = JSON.parse('{"s":{"toString":{"t":1},"B":2,"__proto__":{"x":1}}}') as Record<string, unknown>;
    const applied = applyOpenApiPatch(withProtoKeys, diffOpenApiDocument(withProtoKeys, next));
    expect(JSON.stringify(applied)).toBe(JSON.stringify(next));
  });
});
