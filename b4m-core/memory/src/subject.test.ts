import { describe, expect, it } from 'vitest';
import { resolveSubject, subjectKey } from './subject';

describe('subjectKey', () => {
  it('is stable across case, punctuation, and word order', () => {
    const a = subjectKey('User loves sushi');
    expect(subjectKey('user loves sushi!!!')).toBe(a);
    expect(subjectKey('Sushi, loves user')).toBe(a);
  });

  it('drops stopwords and single characters', () => {
    expect(subjectKey('I work in the pharma industry')).toBe(subjectKey('pharma industry work'));
  });

  it('does NOT merge paraphrases or inflections (the known cheap-resolver limit)', () => {
    expect(subjectKey('loves sushi')).not.toBe(subjectKey('love sushi'));
    expect(subjectKey('targets pharma')).not.toBe(subjectKey('pursuing pharma clients'));
  });

  it('is empty for content-free text', () => {
    expect(subjectKey('the a of')).toBe('');
  });
});

describe('resolveSubject', () => {
  it('prefers an explicit subject over the fact', () => {
    expect(resolveSubject({ subject: 'role', fact: 'anything at all' })).toBe('role');
  });

  it('derives from the fact when no subject is given', () => {
    expect(resolveSubject({ fact: 'User loves sushi' })).toBe(subjectKey('User loves sushi'));
  });

  it('returns null when neither yields a usable key', () => {
    expect(resolveSubject({ subject: '   ', fact: 'the a of' })).toBeNull();
    expect(resolveSubject({})).toBeNull();
  });
});
