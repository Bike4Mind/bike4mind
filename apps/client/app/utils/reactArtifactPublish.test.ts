import { describe, it, expect } from 'vitest';
import { decodeReactPublishUpload, encodeReactPublishUpload, reactPublishFiles } from './reactArtifactPublish';

describe('reactPublishFiles', () => {
  it('keeps only the siblings the entry reaches, by identifier', () => {
    expect(
      reactPublishFiles({
        role: 'entry',
        files: { Stopwatch: 'sw', Unrelated: 'u', Display: 'd' },
        dependencies: [],
        siblings: [
          { identifier: 'Stopwatch', title: 'Stopwatch' },
          { identifier: 'Display', title: 'Display' },
        ],
      })
    ).toEqual({ Stopwatch: 'sw', Display: 'd' });
  });

  it('publishes as a single file without an entry role or a reached sibling', () => {
    expect(reactPublishFiles(undefined)).toBeNull();
    expect(reactPublishFiles({ role: 'sibling', entryTitle: 'App' })).toBeNull();
    expect(reactPublishFiles({ role: 'entry', files: { A: 'a' }, dependencies: [], siblings: [] })).toBeNull();
  });
});

describe('react publish upload', () => {
  it('round-trips the entry and files', () => {
    const raw = encodeReactPublishUpload({ entry: 'e', files: { A: 'a', B: 'b' } });
    const decoded = decodeReactPublishUpload(raw, ['B', 'A']);
    expect(decoded.entry).toBe('e');
    expect({ ...decoded.files }).toEqual({ A: 'a', B: 'b' });
  });

  it('rejects malformed uploads', () => {
    expect(() => decodeReactPublishUpload('import x', [])).toThrow('not valid JSON');
    expect(() => decodeReactPublishUpload('{"entry":1,"files":{}}', [])).toThrow('entry source and a files map');
    expect(() => decodeReactPublishUpload('{"entry":"e","files":{"A":2}}', ['A'])).toThrow(
      '"A" is not a source string'
    );
  });

  it('rejects files that differ from the declared identifiers', () => {
    const raw = encodeReactPublishUpload({ entry: 'e', files: { A: 'a' } });
    expect(() => decodeReactPublishUpload(raw, ['A', 'B'])).toThrow('do not match');
    expect(() => decodeReactPublishUpload(raw, ['B'])).toThrow('do not match');
  });

  it('keeps a __proto__ key as an ordinary file', () => {
    const decoded = decodeReactPublishUpload('{"entry":"e","files":{"__proto__":"p"}}', ['__proto__']);
    expect(Object.keys(decoded.files)).toEqual(['__proto__']);
    expect(decoded.files.__proto__).toBe('p');
  });
});
