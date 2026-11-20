import { describe, expect, it } from 'vitest';
import { diffLanguage } from './diffLanguage';

describe('diffLanguage', () => {
  it('reads known file names and extensions', () => {
    expect(diffLanguage('src/Dockerfile')).toBe('docker');
    expect(diffLanguage('a/b.ts')).toBe('typescript');
  });

  it('treats a name or extension that is an Object member as unrecognised', () => {
    expect(diffLanguage('constructor')).toBe('text');
    expect(diffLanguage('src/a.constructor')).toBe('text');
    expect(diffLanguage('src/a.__proto__')).toBe('text');
  });
});
