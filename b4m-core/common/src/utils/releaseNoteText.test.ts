import { describe, expect, it } from 'vitest';
import { findDenied } from './releaseNoteText';

describe('findDenied', () => {
  it.each(['Acme', 'A C M E', 'A.C.M.E', 'Ac-me', 'ACME_Corp', 'AcmeCorp', 'GPUAcme', 'v2Acme', 'Acmes', 'XACME'])(
    'matches a term that starts or ends a word: %j',
    text => {
      expect(findDenied(`Built with ${text} today`, ['acme'])).toBe('acme');
    }
  );

  it('matches Cyrillic lookalike letters', () => {
    expect(findDenied('Built with Асmе', ['acme'])).toBe('acme');
  });

  it.each(['Session quest history', 'listSessionQuests', 'A reaction queue'])(
    'ignores a term that only spans the join of two words: %j',
    text => {
      expect(findDenied(text, ['onque'])).toBeUndefined();
    }
  );

  it('lets a term buried mid-word at both ends through', () => {
    expect(findDenied('the myacmes plan', ['acme'])).toBeUndefined();
  });

  it('matches a multi-word term at a word boundary regardless of its own spacing', () => {
    expect(findDenied('Uses Project Falcon now', ['project-falcon'])).toBe('project-falcon');
  });

  it('returns the first matching term and skips terms that fold to nothing', () => {
    expect(findDenied('Acme and Globex', ['--', 'globex', 'acme'])).toBe('globex');
  });
});
