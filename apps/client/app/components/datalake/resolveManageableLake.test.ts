import { describe, it, expect } from 'vitest';
import type { ManageableDataLakeConfig } from '@bike4mind/common';
import { resolveManageableLake } from './resolveManageableLake';

const lake = (over: Partial<ManageableDataLakeConfig>): ManageableDataLakeConfig =>
  ({
    id: 'lake-1',
    slug: 'lake-a',
    name: 'Lake A',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake-a',
    canManage: true,
    ...over,
  }) as ManageableDataLakeConfig;

const file = (tagNames: string[]) => ({ tags: tagNames.map(name => ({ name })) }) as never;

describe('resolveManageableLake', () => {
  it('resolves the single manageable lake matching the membership meta-tag', () => {
    const l = lake({});
    expect(resolveManageableLake(file(['lk:books', 'datalake:lake-a']), [l])).toBe(l);
  });

  it('returns null when the resolved lake is not manageable by the caller', () => {
    expect(resolveManageableLake(file(['datalake:lake-a']), [lake({ canManage: false })])).toBeNull();
  });

  it('returns null when canManage is absent (fallback/read-only lakes)', () => {
    expect(resolveManageableLake(file(['datalake:lake-a']), [lake({ canManage: undefined })])).toBeNull();
  });

  it('returns null for a file with no membership meta-tag (prefix-only files)', () => {
    expect(resolveManageableLake(file(['lk:books']), [lake({})])).toBeNull();
  });

  it('returns null when the file belongs to more than one known lake', () => {
    const a = lake({});
    const b = lake({ id: 'lake-2', slug: 'lake-b', datalakeTag: 'datalake:lake-b' });
    expect(resolveManageableLake(file(['datalake:lake-a', 'datalake:lake-b']), [a, b])).toBeNull();
  });

  it('returns null when the lake list is not loaded yet', () => {
    expect(resolveManageableLake(file(['datalake:lake-a']), undefined)).toBeNull();
  });

  it('returns null for a membership tag naming no accessible lake', () => {
    expect(resolveManageableLake(file(['datalake:other']), [lake({})])).toBeNull();
  });

  it('returns null for a file with no tags at all', () => {
    expect(resolveManageableLake({ tags: undefined } as never, [lake({})])).toBeNull();
  });
});
