import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { setupMongoTest } from '../../__test__/utils';
import User from './UserModel';

const hashPattern = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Profile updates write answers through findOneAndUpdate/updateOne, not document save, so the
 * update hook is the main path and needs its own coverage: a plaintext answer stored by a `$set`
 * never touches `pre('validate')`.
 */
describe('User security question hashing on update', () => {
  setupMongoTest();

  it('hashes a plaintext answer set through $set', async () => {
    const user = await User.create({ username: 'security-question-update', name: 'Security Question Update' });

    await User.updateOne(
      { _id: user._id },
      { $set: { securityQuestions: [{ question: 'First pet?', answer: 'canary-answer' }] } }
    );

    const stored = (await User.findById(user._id))!.securityQuestions![0].answer;
    expect(stored).toMatch(hashPattern);
    expect(await bcrypt.compare('canary-answer', stored)).toBe(true);
  });

  it('does not re-hash an answer that is already a hash', async () => {
    const existing = await bcrypt.hash('canary-answer', 12);
    const user = await User.create({ username: 'security-question-update-hashed', name: 'Already Hashed' });

    await User.updateOne(
      { _id: user._id },
      { $set: { securityQuestions: [{ question: 'First pet?', answer: existing }] } }
    );

    expect((await User.findById(user._id))!.securityQuestions![0].answer).toBe(existing);
  });

  it('hashes an answer written through the positional path', async () => {
    const user = await User.create({
      username: 'security-question-positional',
      name: 'Positional',
      securityQuestions: [{ question: 'First pet?', answer: 'original' }],
    });

    await User.updateOne({ _id: user._id }, { $set: { 'securityQuestions.0.answer': 'canary-answer' } });

    const stored = (await User.findById(user._id))!.securityQuestions![0].answer;
    expect(stored).toMatch(hashPattern);
    expect(await bcrypt.compare('canary-answer', stored)).toBe(true);
  });
});

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
