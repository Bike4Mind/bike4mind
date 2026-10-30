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
  await Invite.deleteMany({});
});

const seed = async (
  recipients: { pending?: string[]; accepted?: string[]; refused?: string[] } | null,
  remaining = 2
) => {
  const doc = await Invite.create({
    type: InviteType.FabFile,
    documentId: new mongoose.Types.ObjectId().toString(),
    remaining,
    ...(recipients ? { recipients: { accepted: [], refused: [], ...recipients } } : {}),
  });
  if (recipients === null) await Invite.collection.updateOne({ _id: doc._id }, { $unset: { recipients: '' } });
  return doc.id as string;
};

const stored = async (id: string) => (await Invite.findById(id).lean())!;

describe('InviteRepository recipient writes', () => {
  it('acceptRecipient moves the email to accepted and counts the use', async () => {
    const id = await seed({ pending: ['A@x.com', 'b@x.com'], refused: ['a@x.com'] });

    await repo.acceptRecipient(id, 'a@x.com');

    const invite = await stored(id);
    expect(invite.recipients).toMatchObject({ pending: ['b@x.com'], accepted: ['a@x.com'], refused: [] });
    expect(invite.accepted).toBe(1);
    expect(invite.remaining).toBe(1);
  });

  it('acceptRecipient refuses an invite with no slot left and leaves link invites without pending', async () => {
    const spent = await seed({ pending: ['a@x.com'] }, 0);
    expect(await repo.acceptRecipient(spent, 'a@x.com')).toBeNull();
    expect((await stored(spent)).recipients?.accepted).toEqual([]);

    const link = await seed({}, 1);
    await Invite.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(link) },
      { $unset: { 'recipients.pending': '' } }
    );
    await repo.acceptRecipient(link, 'a@x.com');
    const invite = await stored(link);
    expect(invite.recipients?.accepted).toEqual(['a@x.com']);
    expect(invite.recipients?.pending).toBeUndefined();
  });

  it('concurrent accepts of the same email spend one slot', async () => {
    const id = await seed({ pending: [] }, 3);

    const results = await Promise.all([repo.acceptRecipient(id, 'a@x.com'), repo.acceptRecipient(id, 'A@x.com')]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const invite = await stored(id);
    expect(invite.recipients?.accepted).toHaveLength(1);
    expect(invite.remaining).toBe(2);
    expect(invite.accepted).toBe(1);
  });

  it('acceptRecipient on a named invite refuses an email that is no longer pending', async () => {
    const id = await seed({ pending: ['a@x.com', 'b@x.com'] });
    await Invite.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { isLinkOnly: false } });

    await repo.cancelPendingRecipient(id, 'a@x.com');

    expect(await repo.acceptRecipient(id, 'a@x.com')).toBeNull();
    expect(await repo.acceptRecipient(id, 'B@x.com')).not.toBeNull();
    const invite = await stored(id);
    expect(invite.recipients?.accepted).toEqual(['B@x.com']);
    expect(invite.remaining).toBe(0);
  });

  it('refusePendingRecipient never drives remaining below zero', async () => {
    const id = await seed({ pending: ['a@x.com'] }, 0);

    expect(await repo.refusePendingRecipient(id, 'a@x.com')).not.toBeNull();
    expect((await stored(id)).remaining).toBe(0);
  });

  it('refusePendingRecipient moves the email to refused and spends a slot once', async () => {
    const id = await seed({ pending: ['A@x.com', 'b@x.com'] });

    expect(await repo.refusePendingRecipient(id, 'a@X.com')).not.toBeNull();
    expect(await repo.refusePendingRecipient(id, 'a@x.com')).toBeNull();

    const invite = await stored(id);
    expect(invite.recipients?.pending).toEqual(['b@x.com']);
    expect(invite.recipients?.refused).toEqual(['a@X.com']);
    expect(invite.remaining).toBe(1);
  });

  it('cancelPendingRecipient drops the email and caps remaining at the pending left', async () => {
    const id = await seed({ pending: ['a@x.com', 'b@x.com'], accepted: ['c@x.com'] }, 5);

    await repo.cancelPendingRecipient(id, 'B@x.com');

    const invite = await stored(id);
    expect(invite.recipients?.pending).toEqual(['a@x.com']);
    expect(invite.recipients?.accepted).toEqual(['c@x.com']);
    expect(invite.remaining).toBe(1);
    expect(await repo.cancelPendingRecipient(id, 'b@x.com')).toBeNull();
  });

  it('closeInvite clears pending and remaining but keeps accepted and refused', async () => {
    const id = await seed({ pending: ['a@x.com'], accepted: ['b@x.com'], refused: ['c@x.com'] });

    await repo.closeInvite(id);

    const invite = await stored(id);
    expect(invite.remaining).toBe(0);
    expect(invite.recipients).toMatchObject({ pending: [], accepted: ['b@x.com'], refused: ['c@x.com'] });
  });

  it('closeInvite leaves an invite without recipients without them', async () => {
    const id = await seed(null);

    await repo.closeInvite(id);

    const invite = await stored(id);
    expect(invite.remaining).toBe(0);
    expect(invite.recipients).toBeUndefined();
  });

  it('concurrent refusals by different recipients keep both changes', async () => {
    const id = await seed({ pending: ['a@x.com', 'b@x.com', 'c@x.com'] }, 3);

    await Promise.all([repo.refusePendingRecipient(id, 'a@x.com'), repo.refusePendingRecipient(id, 'b@x.com')]);

    const invite = await stored(id);
    expect(invite.recipients?.pending).toEqual(['c@x.com']);
    expect([...(invite.recipients?.refused ?? [])].sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(invite.remaining).toBe(1);
  });

  it('a recipient write does not revert an accept that landed after the caller read the invite', async () => {
    const id = await seed({ pending: ['a@x.com', 'b@x.com'] });
    await Invite.updateOne(
      { _id: id },
      { $pull: { 'recipients.pending': 'b@x.com' }, $push: { 'recipients.accepted': 'b@x.com' } }
    );

    await repo.refusePendingRecipient(id, 'a@x.com');

    const invite = await stored(id);
    expect(invite.recipients).toMatchObject({ pending: [], accepted: ['b@x.com'], refused: ['a@x.com'] });
  });
});
