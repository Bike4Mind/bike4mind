import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await User.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
});

const seed = async (email: string | null) => {
  const user = await User.create({ username: `u-${new mongoose.Types.ObjectId()}`, name: 'Claim fixture', email });
  return String(user._id);
};
const claimOf = async (id: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.freeCreditClaimEmail;

describe('UserRepository.claimFreeCreditGrant', () => {
  it('lets one alias of a Gmail inbox claim and refuses every other alias', async () => {
    const first = await seed('x.y@gmail.com');
    const plusAlias = await seed('xy+1@gmail.com');
    const googlemailAlias = await seed('X.Y+2@googlemail.com');

    expect(await userRepository.claimFreeCreditGrant(first)).toBe(true);
    expect(await userRepository.claimFreeCreditGrant(plusAlias)).toBe(false);
    expect(await userRepository.claimFreeCreditGrant(googlemailAlias)).toBe(false);

    expect(await claimOf(first)).toBe('xy@gmail.com');
    expect(await claimOf(plusAlias)).toBeUndefined();
  });

  it('keeps the typed address as the account email', async () => {
    const id = await seed('X.Y+tag@gmail.com');
    await userRepository.claimFreeCreditGrant(id);
    expect((await User.findById(id).lean())?.email).toBe('X.Y+tag@gmail.com');
  });

  it('lets exactly one of several concurrent aliases claim', async () => {
    const ids = await Promise.all(['a.b@gmail.com', 'ab+1@gmail.com', 'ab+2@gmail.com', 'a.b+3@gmail.com'].map(seed));
    const results = await Promise.all(ids.map(id => userRepository.claimFreeCreditGrant(id)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('is idempotent for the account that holds the claim', async () => {
    const id = await seed('x@gmail.com');
    expect(await userRepository.claimFreeCreditGrant(id)).toBe(true);
    expect(await userRepository.claimFreeCreditGrant(id)).toBe(true);
  });

  it('treats distinct inboxes independently', async () => {
    expect(await userRepository.claimFreeCreditGrant(await seed('x@gmail.com'))).toBe(true);
    expect(await userRepository.claimFreeCreditGrant(await seed('x@example.com'))).toBe(true);
    expect(await userRepository.claimFreeCreditGrant(await seed('x+1@example.com'))).toBe(true);
  });

  it('allows an account with no email, which has nothing to dedupe on', async () => {
    const id = await seed(null);
    expect(await userRepository.claimFreeCreditGrant(id)).toBe(true);
    expect(await claimOf(id)).toBeUndefined();
  });

  it('refuses an unknown account', async () => {
    expect(await userRepository.claimFreeCreditGrant(String(new mongoose.Types.ObjectId()))).toBe(false);
  });
});
