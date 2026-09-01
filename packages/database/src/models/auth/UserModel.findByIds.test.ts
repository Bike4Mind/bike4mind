import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

/**
 * `findByIds` resolves arbitrary id lists - including ids that originate from non-user principals
 * (Slack ids, agent handles) via the data-lake access trail. A raw `new ObjectId(id)` throws on
 * anything not ObjectId-shaped, which would 500 the caller, so the repo must filter first.
 */
describe('UserModel.findByIds - tolerates non-ObjectId ids', () => {
  it('returns the users whose ids are valid and silently drops the rest', async () => {
    const a = new Types.ObjectId().toString();
    const b = new Types.ObjectId().toString();
    await User.create({ _id: a, username: 'alice', name: 'Alice', email: 'alice@example.com' });
    await User.create({ _id: b, username: 'bob', name: 'Bob', email: 'bob@example.com' });

    const found = await userRepository.findByIds([a, 'slack:U123', 'agent-handle', b]);
    expect(found.map(u => u.id).sort()).toEqual([a, b].sort());
  });

  it('does not throw on an all-invalid id list, returning nothing', async () => {
    await expect(userRepository.findByIds(['slack:U123', 'not-an-oid'])).resolves.toEqual([]);
  });
});
