import { describe, expect, it } from 'vitest';
import { buildNotebookImportKeys, isValidNotebookImportId, parseNotebookImportKey } from './notebookImportKeys';

describe('notebook import object keys', () => {
  it.each(['1700000000000', '000123'])('round-trips the data key and preserves its options sibling (%s)', importId => {
    const keys = buildNotebookImportKeys('user-1', importId);
    expect(keys).toEqual({
      dataKey: `notebooks/user-1/${importId}.json`,
      optionsKey: `notebooks/user-1/${importId}.options.json`,
    });
    expect(parseNotebookImportKey(keys.dataKey)).toEqual({ userId: 'user-1', importId, ...keys });
    expect(parseNotebookImportKey(keys.optionsKey)).toBeNull();
  });

  it.each(['', 'abc', '1.2', '123\n', '../123', '2026-08-10T00-00-00'])(
    'rejects malformed import IDs (%j)',
    importId => {
      expect(isValidNotebookImportId(importId)).toBe(false);
      expect(() => buildNotebookImportKeys('user-1', importId)).toThrow('Invalid notebook import key');
    }
  );

  it.each([
    'notebooks/user-1/123.json/extra',
    'notebooks/user-1/123.other.json',
    'notebooks/user-1/123.json\n',
    'notebooks//123.json',
    'notebooks/../123.json',
    'history/user-1/123.json',
    'notebooks/user-1/no-time.json',
    'notebooks/user-1/123.options.json',
    'notebooks/user-1/2026-08-10T00-00-00.json',
  ])('ignores objects outside the notebook data contract (%j)', key => {
    expect(parseNotebookImportKey(key)).toBeNull();
  });
});
