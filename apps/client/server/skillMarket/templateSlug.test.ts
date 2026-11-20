import { describe, it, expect } from 'vitest';
import { BadRequestError } from '@bike4mind/common';
import { firstFreeTemplateSlug, templateSlugBase, validateTemplateSlug } from './templateSlug';

describe('validateTemplateSlug', () => {
  it.each(['formatter', 'code-review-2', 'a', 'x'.repeat(64)])('accepts %s', slug => {
    expect(validateTemplateSlug(slug)).toBe(slug);
  });

  it.each(['Formatter', 'code_review', '-lead', 'trail-', 'two words', 'caf\u00e9', 'x'.repeat(65), ''])(
    'refuses %j',
    slug => {
      expect(() => validateTemplateSlug(slug)).toThrow(BadRequestError);
    }
  );

  it.each(['admin', 'api', 'login', 'signup', 'new'])('refuses the reserved word %s', slug => {
    expect(() => validateTemplateSlug(slug)).toThrow(/reserved/);
  });
});

describe('templateSlugBase', () => {
  it.each([
    ['formatter', 'formatter'],
    ['Code Review', 'code-review'],
    ['  --Weird__Name!!  ', 'weird-name'],
    ['\u65e5\u672c\u8a9e', 'skill'],
  ])('derives %j as %s', (name, base) => {
    expect(templateSlugBase(name)).toBe(base);
  });

  it('leaves room for a suffix and never ends with a hyphen', () => {
    const base = templateSlugBase(`${'a'.repeat(57)}-b${'c'.repeat(10)}`);
    expect(base.length).toBeLessThanOrEqual(58);
    expect(base.endsWith('-')).toBe(false);
    expect(validateTemplateSlug(firstFreeTemplateSlug(base, new Set([base])))).toBeTruthy();
  });
});

describe('firstFreeTemplateSlug', () => {
  it('takes the base when it is free', () => {
    expect(firstFreeTemplateSlug('formatter', new Set())).toBe('formatter');
  });

  it('adds the lowest free numeric suffix on a clash', () => {
    expect(firstFreeTemplateSlug('formatter', new Set(['formatter']))).toBe('formatter-2');
    expect(firstFreeTemplateSlug('formatter', new Set(['formatter', 'formatter-2', 'formatter-4']))).toBe(
      'formatter-3'
    );
  });

  it('skips a reserved base', () => {
    expect(firstFreeTemplateSlug('admin', new Set())).toBe('admin-2');
  });
});
