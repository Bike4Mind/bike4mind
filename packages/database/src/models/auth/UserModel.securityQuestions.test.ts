import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { setupMongoTest } from '../../__test__/utils';
import User from './UserModel';

const hashPattern = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * The document path (User.create / doc.save) is defense in depth beside the update hooks: a
 * plaintext answer reaching the database from either door defeats the hashing entirely.
 */
describe('User security question hashing on save', () => {
  setupMongoTest();

  it('stores a bcrypt hash of an answer supplied on create', async () => {
    const user = await User.create({
      username: 'security-question-save',
      name: 'Security Question Save',
      securityQuestions: [{ question: 'First pet?', answer: 'canary-answer' }],
    });

    const stored = (await User.findById(user._id))!.securityQuestions![0].answer;
    expect(stored).toMatch(hashPattern);
    expect(await bcrypt.compare('canary-answer', stored)).toBe(true);
  });

  it('does not re-hash an answer that is already a hash', async () => {
    const existing = await bcrypt.hash('canary-answer', 12);

    const user = await User.create({
      username: 'security-question-already-hashed',
      name: 'Security Question Hashed',
      securityQuestions: [{ question: 'First pet?', answer: existing }],
    });

    expect((await User.findById(user._id))!.securityQuestions![0].answer).toBe(existing);
  });
});
