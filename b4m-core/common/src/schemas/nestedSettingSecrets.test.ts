import { describe, expect, it } from 'vitest';
import {
  hasNestedSecretValue,
  isValidNestedSecretGroups,
  mapNestedSecrets,
  NESTED_SECRET_PLACEHOLDER,
  redactNestedSecrets,
  type NestedSecretGroup,
} from './nestedSettingSecrets';

const groups: NestedSecretGroup[] = [{ arrayKey: 'targets', identityFields: ['id'], secretFields: ['token'] }];

describe('NESTED_SECRET_PLACEHOLDER', () => {
  it('is eight bullets, the value stored round trips already depend on', () => {
    expect(NESTED_SECRET_PLACEHOLDER).toHaveLength(8);
    expect(new Set(NESTED_SECRET_PLACEHOLDER)).toEqual(new Set(['•']));
  });
});

describe('isValidNestedSecretGroups', () => {
  it('accepts a well-formed list', () => {
    expect(isValidNestedSecretGroups(groups)).toBe(true);
  });

  it.each([
    ['not a list', { arrayKey: 'targets' }],
    ['an empty list', []],
    ['a blank array key', [{ arrayKey: ' ', identityFields: ['id'], secretFields: ['token'] }]],
    ['a reserved array key', [{ arrayKey: '__proto__', identityFields: ['id'], secretFields: ['token'] }]],
    ['no identity field', [{ arrayKey: 'targets', identityFields: [], secretFields: ['token'] }]],
    ['no secret field', [{ arrayKey: 'targets', identityFields: ['id'], secretFields: [] }]],
    ['a reserved secret field', [{ arrayKey: 'targets', identityFields: ['id'], secretFields: ['constructor'] }]],
    ['a field that is both', [{ arrayKey: 'targets', identityFields: ['id'], secretFields: ['id'] }]],
  ])('rejects %s', (_label, value) => {
    expect(isValidNestedSecretGroups(value)).toBe(false);
  });
});

describe('redactNestedSecrets', () => {
  it('masks set secret fields and leaves the rest, without touching the input', () => {
    const value = { enabled: true, targets: [{ id: 'a', token: 'plain', note: 'n' }] };
    expect(redactNestedSecrets(value, groups)).toEqual({
      enabled: true,
      targets: [{ id: 'a', token: NESTED_SECRET_PLACEHOLDER, note: 'n' }],
    });
    expect(value.targets[0].token).toBe('plain');
  });

  it('leaves an unset secret field unset, so an empty field does not read as stored', () => {
    const value = { targets: [{ id: 'a', token: '' }, { id: 'b' }, { id: 'c', token: null }] };
    expect(redactNestedSecrets(value, groups)).toEqual(value);
  });

  it('masks a set secret field of any type', () => {
    expect(redactNestedSecrets({ targets: [{ id: 'a', token: { raw: 'plain' } }] }, groups)).toEqual({
      targets: [{ id: 'a', token: NESTED_SECRET_PLACEHOLDER }],
    });
  });

  it('returns a value with no such array, or that is not an object, as it is', () => {
    expect(redactNestedSecrets({ targets: 'none' }, groups)).toEqual({ targets: 'none' });
    expect(redactNestedSecrets('text', groups)).toBe('text');
    expect(redactNestedSecrets(null, groups)).toBeNull();
  });
});

describe('hasNestedSecretValue', () => {
  it('is true only when a declared secret field holds something', () => {
    expect(hasNestedSecretValue({ targets: [{ id: 'a', token: 'plain' }] }, groups)).toBe(true);
    expect(hasNestedSecretValue({ targets: [{ id: 'a', token: '' }] }, groups)).toBe(false);
    expect(hasNestedSecretValue({ targets: [] }, groups)).toBe(false);
    expect(hasNestedSecretValue(undefined, groups)).toBe(false);
  });
});

describe('mapNestedSecrets', () => {
  const store = (submitted: string, stored: string | undefined) => `${submitted}|${stored ?? 'none'}`;

  it('hands each set secret the stored value of the item with the same identity, not the same index', () => {
    const stored = {
      targets: [
        { id: 'a', token: 'stored-a' },
        { id: 'b', token: 'stored-b' },
      ],
    };
    const submitted = {
      targets: [
        { id: 'b', token: 'x' },
        { id: 'new', token: 'y' },
      ],
    };
    expect(mapNestedSecrets(submitted, stored, groups, store)).toEqual({
      targets: [
        { id: 'b', token: 'x|stored-b' },
        { id: 'new', token: 'y|none' },
      ],
    });
    expect(submitted.targets[0].token).toBe('x');
  });

  it('skips unset secret fields', () => {
    const value = { targets: [{ id: 'a', token: '' }, { id: 'b' }] };
    expect(mapNestedSecrets(value, undefined, groups, store)).toEqual(value);
  });

  it('never matches an item that has no identity', () => {
    const stored = { targets: [{ token: 'stored' }] };
    expect(mapNestedSecrets({ targets: [{ token: 'x' }] }, stored, groups, store)).toEqual({
      targets: [{ token: 'x|none' }],
    });
  });

  it('needs every identity field to match', () => {
    const pair: NestedSecretGroup[] = [
      { arrayKey: 'targets', identityFields: ['id', 'zone'], secretFields: ['token'] },
    ];
    const stored = { targets: [{ id: 'a', zone: 1, token: 'stored' }] };
    expect(mapNestedSecrets({ targets: [{ id: 'a', zone: 2, token: 'x' }] }, stored, pair, store)).toEqual({
      targets: [{ id: 'a', zone: 2, token: 'x|none' }],
    });
  });

  it('ignores a stored secret that is not a string', () => {
    const stored = { targets: [{ id: 'a', token: 42 }] };
    expect(mapNestedSecrets({ targets: [{ id: 'a', token: 'x' }] }, stored, groups, store)).toEqual({
      targets: [{ id: 'a', token: 'x|none' }],
    });
  });

  it('refuses a set secret field that is not a string', () => {
    expect(() => mapNestedSecrets({ targets: [{ id: 'a', token: 42 }] }, undefined, groups, store)).toThrow(TypeError);
  });
});
