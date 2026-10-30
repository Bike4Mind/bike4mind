import { describe, expect, it } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { applyBaseUserUpdates, updateUserSchema } from './update';

const user = {
  id: 'user-1',
  securityQuestions: [{ question: 'First pet?', answer: 'stored-answer-hash' }],
} as IUserDocument;

describe('security question profile updates', () => {
  it('preserves the stored answer when the profile submits a blank for the same question', () => {
    const updated = applyBaseUserUpdates(user, {
      securityQuestions: [{ question: 'First pet?', answer: '' }],
    });
    expect(updated.securityQuestions).toEqual(user.securityQuestions);
  });

  it.each(['New question?', 'Renamed pet question?'])('requires an answer for %s', question => {
    expect(() => applyBaseUserUpdates(user, { securityQuestions: [{ question, answer: '' }] })).toThrow(
      'An answer is required'
    );
  });

  it('keeps each stored answer when two questions share the same text', () => {
    const duplicated = {
      id: 'user-1',
      securityQuestions: [
        { question: 'First pet?', answer: 'hash-one' },
        { question: 'First pet?', answer: 'hash-two' },
      ],
    } as IUserDocument;

    const updated = applyBaseUserUpdates(duplicated, {
      securityQuestions: [
        { question: 'First pet?', answer: '' },
        { question: 'First pet?', answer: '' },
      ],
    });

    expect(updated.securityQuestions?.map(question => question.answer)).toEqual(['hash-one', 'hash-two']);
  });

  it('keeps the second stored answer when the first of two duplicate questions is replaced', () => {
    const duplicated = {
      id: 'user-1',
      securityQuestions: [
        { question: 'First pet?', answer: 'hash-one' },
        { question: 'First pet?', answer: 'hash-two' },
      ],
    } as IUserDocument;

    const updated = applyBaseUserUpdates(duplicated, {
      securityQuestions: [
        { question: 'First pet?', answer: 'replacement' },
        { question: 'First pet?', answer: '' },
      ],
    });

    expect(updated.securityQuestions?.map(question => question.answer)).toEqual(['replacement', 'hash-two']);
  });

  it('bounds the amount of answer hashing requested by a profile update', () => {
    expect(
      updateUserSchema.safeParse({
        securityQuestions: Array.from({ length: 11 }, () => ({ question: '?', answer: 'x' })),
      }).success
    ).toBe(false);
    expect(
      updateUserSchema.safeParse({ securityQuestions: [{ question: '?', answer: 'x'.repeat(1025) }] }).success
    ).toBe(false);
  });
});
