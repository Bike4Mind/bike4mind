import { describe, it, expect } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const T = new Date('2026-10-10T12:00:00Z');
const hours = (n: number) => new Date(T.getTime() + n * 3600 * 1000);
const base = {
  excludeIds: [] as string[],
  from: hours(-72),
  to: hours(72),
  ip: null,
  ja4: null,
  mailbox: null,
  mailDomain: null,
  limit: 50,
};

let seq = 0;
const createUser = async (email: string, set: Record<string, unknown> = {}) => {
  seq += 1;
  const user = await User.create({ username: `link${seq}`, name: `Link ${seq}`, email });
  // Raw driver write: mongoose timestamps make createdAt immutable through the model.
  await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: T, ...set } });
  return user.id as string;
};

const emailsOf = async (input: Partial<Parameters<typeof userRepository.findSignupLinkCandidates>[0]>) =>
  (await userRepository.findSignupLinkCandidates({ ...base, ...input })).map(c => c.email).sort();

describe('UserRepository.findSignupLinkCandidates', () => {
  it('reads nothing without a criterion', async () => {
    await createUser('a@example.com');
    expect(await emailsOf({})).toEqual([]);
  });

  it('matches the signup IP and JA4, minus excluded ids and rows outside the window', async () => {
    const self = await createUser('self@example.com', { 'signupMeta.ip': '192.0.2.1' });
    await createUser('ip@example.com', { 'signupMeta.ip': '192.0.2.1' });
    await createUser('ja4@example.com', { 'signupMeta.ja4': 'ja4-x' });
    await createUser('other@example.com', { 'signupMeta.ip': '192.0.2.2' });
    await createUser('late@example.com', { 'signupMeta.ip': '192.0.2.1', createdAt: hours(73) });
    expect(await emailsOf({ excludeIds: [self], ip: '192.0.2.1', ja4: 'ja4-x' })).toEqual([
      'ip@example.com',
      'ja4@example.com',
    ]);
  });

  it('matches mailbox aliases: +tags, Gmail dots, googlemail, but not other mailboxes', async () => {
    await createUser('johnsmith@gmail.com');
    await createUser('john.smith@gmail.com');
    await createUser('j.o.h.n.smith+x@gmail.com');
    await createUser('johnsmith@googlemail.com');
    await createUser('johnsmithe@gmail.com');
    await createUser('john.smith@example.com');
    const mailbox = { local: 'johnsmith', domains: ['gmail.com', 'googlemail.com'], ignoreDots: true };
    expect(await emailsOf({ mailbox })).toEqual([
      'j.o.h.n.smith+x@gmail.com',
      'john.smith@gmail.com',
      'johnsmith@gmail.com',
      'johnsmith@googlemail.com',
    ]);
  });

  it('treats dots literally outside Gmail and escapes regex characters', async () => {
    await createUser('a.b@icloud.com');
    await createUser('ab@icloud.com');
    await createUser('a.b@me.com');
    await createUser('axb@icloud.com');
    expect(await emailsOf({ mailbox: { local: 'a.b', domains: ['icloud.com', 'me.com'], ignoreDots: false } })).toEqual(
      ['a.b@icloud.com', 'a.b@me.com']
    );
  });

  it('matches a mail domain exactly at the end of the address, and honours the limit', async () => {
    await createUser('x@corp.example');
    await createUser('y@corp.example');
    await createUser('z@notcorp.example');
    expect(await emailsOf({ mailDomain: 'corp.example' })).toEqual(['x@corp.example', 'y@corp.example']);
    expect(
      await userRepository.findSignupLinkCandidates({ ...base, mailDomain: 'corp.example', limit: 1 })
    ).toHaveLength(1);
  });
});
