import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { User } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

describe('security question answers', () => {
  setupMongoTest();
  it('hashes query-written answers and preserves trusted hashes on unrelated updates', async () => {
    const id = '647123456789abcdefabcdef';
    await User.collection.insertOne({
      _id: new (await import('mongoose')).Types.ObjectId(id),
      username: 'test-questions',
    });
    await User.updateOne(
      { _id: id },
      { $set: { securityQuestions: [{ question: 'First pet?', answer: 'answer-canary' }] } }
    );
    const row = await User.collection.findOne({ username: 'test-questions' });
    const hash = row!.securityQuestions![0].answer;
    expect(hash).not.toBe('answer-canary');
    expect(await bcrypt.compare('answer-canary', hash)).toBe(true);
    await User.updateOne({ _id: id }, { $set: { securityQuestions: row!.securityQuestions } });
    expect((await User.collection.findOne({ username: 'test-questions' }))?.securityQuestions?.[0].answer).toBe(hash);
  });
});
