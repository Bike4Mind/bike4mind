import { describe, it, expect } from 'vitest';
import { decodeReactPublishUpload, encodeReactPublishUpload, reactPublishFiles } from './reactArtifactPublish';
import { groupReactArtifacts } from './reactArtifactGroup';

describe('reactPublishFiles', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'preserves the %s sibling through grouping and upload',
    identifier => {
      const entry = {
        type: 'react',
        identifier: 'App',
        title: 'App',
        content: `import { label } from './${identifier}'; export default function App() { return <p>{label}</p>; }`,
        startIndex: 0,
      };
      const sibling = {
        type: 'react',
        identifier,
        title: identifier,
        content: 'export const label = "Sibling";',
        startIndex: 100,
      };
      const files = reactPublishFiles(groupReactArtifacts([entry, sibling]).get(entry));
      expect(files).not.toBeNull();
      if (!files) throw new Error('Expected sibling sources for a multi-file entry.');
      const decoded = decodeReactPublishUpload(encodeReactPublishUpload({ entry: entry.content, files }), [identifier]);
      expect(Object.keys(decoded.files)).toEqual([identifier]);
      expect(decoded.files[identifier]).toBe(sibling.content);
    }
  );

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
