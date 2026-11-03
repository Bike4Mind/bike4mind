import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await User.syncIndexes();
});

describe('UserModel.existsOtherUserWithEmail', () => {
  it('matches another user case-insensitively after trimming the input', async () => {
    await User.create({ username: 'pat', name: 'Pat', email: 'Pat@Example.com' });

    expect(await userRepository.existsOtherUserWithEmail('  pat@example.COM ')).toBe(true);
  });

  it('ignores the excluded user', async () => {
    const self = await User.create({ username: 'pat', name: 'Pat', email: 'pat@example.com' });

    expect(await userRepository.existsOtherUserWithEmail('PAT@example.com', String(self._id))).toBe(false);
  });

  it('treats the input literally and requires a whole-value match', async () => {
    await User.create({ username: 'pat', name: 'Pat', email: 'pat@example.com' });

    expect(await userRepository.existsOtherUserWithEmail('pat@example.co')).toBe(false);
    expect(await userRepository.existsOtherUserWithEmail('pat@example.c.m')).toBe(false);
    expect(await userRepository.existsOtherUserWithEmail('.*')).toBe(false);
  });

  it('matches a stored value that carries surrounding whitespace', async () => {
    await User.collection.insertOne({ username: 'padded', name: 'Pad', email: ' bob@x.com' });

    expect(await userRepository.existsOtherUserWithEmail('bob@x.com')).toBe(true);
  });

  it('returns false for a blank input', async () => {
    await User.create({ username: 'pat', name: 'Pat', email: 'pat@example.com' });

    expect(await userRepository.existsOtherUserWithEmail('   ')).toBe(false);
  });
});

describe('UserModel.existsOtherUserWithUsername', () => {
  it('matches another user case-insensitively and skips the excluded one', async () => {
    const self = await User.create({ username: 'Jane Doe', name: 'Jane', email: 'jane@example.com' });
    await User.create({ username: 'jane.doe', name: 'Other', email: 'other@example.com' });

    expect(await userRepository.existsOtherUserWithUsername('JANE DOE')).toBe(true);
    expect(await userRepository.existsOtherUserWithUsername('jane doe', String(self._id))).toBe(false);
    expect(await userRepository.existsOtherUserWithUsername('Jane.Doe', String(self._id))).toBe(true);
  });

  it('compares the input NFC-normalized', async () => {
    await User.create({ username: 'Jos\u00e9', name: 'Jose', email: 'jose@example.com' });

    expect(await userRepository.existsOtherUserWithUsername('Jose\u0301')).toBe(true);
  });
});

describe('UserModel.existsVerifiedUserOnEmailDomain', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const weekAgo = new Date(Date.now() - 7 * DAY_MS);
  const verified = (email: string, overrides: Record<string, unknown> = {}) =>
    User.collection.insertOne({
      username: email,
      name: email,
      email,
      emailVerified: true,
      emailVerifiedAt: new Date(Date.now() - 8 * DAY_MS),
      ...overrides,
    });

  it('matches a week-old verified user on the domain or a subdomain, case-insensitively', async () => {
    await verified(' A@X.Acme.Example ');

    expect(await userRepository.existsVerifiedUserOnEmailDomain('acme.example', weekAgo)).toBe(true);
    expect(await userRepository.existsVerifiedUserOnEmailDomain('ACME.example', weekAgo)).toBe(true);
  });

  it('does not match a lookalike domain or a regex in the input', async () => {
    await verified('a@notacme.example');

    expect(await userRepository.existsVerifiedUserOnEmailDomain('acme.example', weekAgo)).toBe(false);
    expect(await userRepository.existsVerifiedUserOnEmailDomain('acme.exampl.', weekAgo)).toBe(false);
  });

  it('treats the dots of the domain literally', async () => {
    await verified('someone@acmexco.uk');

    expect(await userRepository.existsVerifiedUserOnEmailDomain('acme.co.uk', weekAgo)).toBe(false);
    expect(await userRepository.existsVerifiedUserOnEmailDomain('acmexco.uk', weekAgo)).toBe(true);
  });

  it('counts a legacy verified row with no verification date', async () => {
    await verified('a@acme.example', { emailVerifiedAt: null });

    expect(await userRepository.existsVerifiedUserOnEmailDomain('acme.example', weekAgo)).toBe(true);
  });

  it('ignores users verified too recently, unverified, banned, system or deleted', async () => {
    await verified('recent@acme.example', { emailVerifiedAt: new Date() });
    await verified('unverified@acme.example', { emailVerified: false });
    await verified('banned@acme.example', { isBanned: true });
    await verified('system@acme.example', { isSystem: true });
    await verified('deleted@acme.example', { deletedAt: new Date() });

    expect(await userRepository.existsVerifiedUserOnEmailDomain('acme.example', weekAgo)).toBe(false);
  });

  it('returns false for a blank domain, even when a stored email ends in a bare separator', async () => {
    await verified('a@acme.example');
    await verified('weird@');
    await verified('x@host.');

    expect(await userRepository.existsVerifiedUserOnEmailDomain('', weekAgo)).toBe(false);
    expect(await userRepository.existsVerifiedUserOnEmailDomain('  ', weekAgo)).toBe(false);
  });
});
