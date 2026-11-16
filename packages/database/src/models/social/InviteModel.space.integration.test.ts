import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { InviteType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Invite, InviteRepository } from './InviteModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
const repo = new InviteRepository(Invite);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);
afterEach(async () => {
  await Invite.deleteMany({}, { hardDelete: true });
});

const seedLink = async (type: InviteType, documentId: string, over: Record<string, unknown> = {}) =>
  (
    await Invite.create({
      type,
      documentId,
      remaining: 3,
      isLinkOnly: true,
      recipients: { pending: [], accepted: [], refused: [] },
      ...over,
    })
  ).id as string;

const stored = async (id: string) => (await Invite.findById(id).lean())!;

describe('InviteRepository.acceptRecipient allowRepeat', () => {
  it('refuses a second accept by the same address by default', async () => {
    const id = await seedLink(InviteType.Space, 'space-a');
    expect(await repo.acceptRecipient(id, 'a@x.com')).not.toBeNull();
    expect(await repo.acceptRecipient(id, 'a@x.com')).toBeNull();
    expect((await stored(id)).remaining).toBe(2);
  });

  it('spends a use on every accept and keeps one accepted entry when allowRepeat is set', async () => {
    const id = await seedLink(InviteType.Space, 'space-a');
    expect(await repo.acceptRecipient(id, 'a@x.com', { allowRepeat: true })).not.toBeNull();
    expect(await repo.acceptRecipient(id, 'a@x.com', { allowRepeat: true })).not.toBeNull();

    const invite = await stored(id);
    expect(invite.recipients?.accepted).toEqual(['a@x.com']);
    expect(invite.remaining).toBe(1);
    expect(invite.accepted).toBe(2);
  });

  it('still refuses a spent or revoked link when allowRepeat is set', async () => {
    const spent = await seedLink(InviteType.Space, 'space-a', { remaining: 0 });
    const revoked = await seedLink(InviteType.Space, 'space-a', { revokedAt: new Date() });
    expect(await repo.acceptRecipient(spent, 'a@x.com', { allowRepeat: true })).toBeNull();
    expect(await repo.acceptRecipient(revoked, 'a@x.com', { allowRepeat: true })).toBeNull();
  });
});

describe('InviteRepository.revokeAllForDocument', () => {
  it('revokes every live invite of that type for the document and nothing else', async () => {
    const link = await seedLink(InviteType.Space, 'space-a');
    const named = await seedLink(InviteType.Space, 'space-a', {
      isLinkOnly: false,
      recipients: { pending: ['a@x.com'], accepted: [], refused: [] },
    });
    const otherSpace = await seedLink(InviteType.Space, 'space-b');
    const otherType = await seedLink(InviteType.Organization, 'space-a');

    expect(await repo.revokeAllForDocument('space-a', InviteType.Space)).toBe(2);

    for (const id of [link, named]) {
      const invite = await stored(id);
      expect(invite.remaining).toBe(0);
      expect(invite.revokedAt).toBeInstanceOf(Date);
    }
    for (const id of [otherSpace, otherType]) {
      const invite = await stored(id);
      expect(invite.remaining).toBe(3);
      expect(invite.revokedAt ?? null).toBeNull();
    }
  });

  it('skips an invite that is already revoked', async () => {
    await seedLink(InviteType.Space, 'space-a', { revokedAt: new Date() });
    expect(await repo.revokeAllForDocument('space-a', InviteType.Space)).toBe(0);
  });
});
