import { describe, it, expect } from 'vitest';
import { normalize } from '../normalize-changeset-package-names.mjs';

describe('normalize', () => {
  it('renames a retired package in quoted and unquoted keys', () => {
    const input = '---\n"@bike4mind/common": minor\n"@bike4mind/services": minor\n---\n\nbody\n';
    expect(normalize(input)).toBe('---\n"@bike4mind/common": minor\n"@bike4mind/services-core": minor\n---\n\nbody\n');
    expect(normalize('---\n@bike4mind/services: patch\n---\nx\n')).toBe('---\n@bike4mind/services-core: patch\n---\nx\n');
  });

  it('keeps the auto-generated marker line and leaves the body alone', () => {
    const input = '<!-- auto-generated -->\n---\n"@bike4mind/services": major\n---\n\n"@bike4mind/services": in prose\n';
    expect(normalize(input)).toBe(
      '<!-- auto-generated -->\n---\n"@bike4mind/services-core": major\n---\n\n"@bike4mind/services": in prose\n'
    );
  });

  it('does not touch current names or files without frontmatter', () => {
    const current = '---\n"@bike4mind/services-core": minor\n"@bike4mind/services-utils": patch\n---\nx\n';
    expect(normalize(current)).toBe(current);
    expect(normalize('# README\n')).toBe('# README\n');
  });
});
