import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../__test__/createMongoServer';
import { EmailTriageItemModel, emailTriageItemRepository, type EmailTriageItemInput } from './EmailTriageItemModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await EmailTriageItemModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await EmailTriageItemModel.deleteMany({});
});

const item = (overrides: Partial<EmailTriageItemInput> = {}): EmailTriageItemInput => ({
  userId: 'user-me',
  emailId: 'email-1',
  kind: 'decision',
  summary: 'Vendor asks to confirm the renewal date.',
  draftReply: { to: 'vendor@example.com', subject: 'Re: Renewal', body: 'Confirming the first of the month.' },
  model: 'test-model',
  tokensUsed: 120,
  ...overrides,
});

describe('emailTriageItemRepository.upsertForEmail', () => {
  it('keeps one item per email and reports whether it created it', async () => {
    expect(await emailTriageItemRepository.upsertForEmail(item())).toEqual({ created: true });
    expect(await emailTriageItemRepository.upsertForEmail(item({ kind: 'fyi', summary: 'changed' }))).toEqual({
      created: false,
    });

    const docs = await EmailTriageItemModel.find({ emailId: 'email-1' }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'decision', draftReply: { to: 'vendor@example.com' } });
  });

  it('leaves exactly one item when upserts for the same email race', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => emailTriageItemRepository.upsertForEmail(item()))
    );

    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(await EmailTriageItemModel.countDocuments({ emailId: 'email-1' })).toBe(1);
  });

  it('rejects a kind outside the enum', async () => {
    await expect(
      emailTriageItemRepository.upsertForEmail(item({ kind: 'spam' as EmailTriageItemInput['kind'] }))
    ).rejects.toThrow(/kind/);
    expect(await emailTriageItemRepository.existsForEmail('email-1')).toBe(false);
  });
});

describe('emailTriageItemRepository.listPending', () => {
  it('returns the owner unbriefed items created before end, oldest first, including ones older than any window', async () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    await EmailTriageItemModel.insertMany(
      [
        { ...item({ emailId: 'carried-over' }), createdAt: at(-1) },
        { ...item({ emailId: 'already-briefed' }), createdAt: at(200), briefedAt: at(300) },
        { ...item({ emailId: 'second' }), createdAt: at(500) },
        { ...item({ emailId: 'first' }), createdAt: at(0) },
        { ...item({ emailId: 'at-end' }), createdAt: at(1000) },
        { ...item({ emailId: 'other-user', userId: 'user-other' }), createdAt: at(100) },
      ],
      { timestamps: false } as Parameters<typeof EmailTriageItemModel.insertMany>[1]
    );

    const listed = await emailTriageItemRepository.listPending('user-me', at(1000), 10);

    expect(listed.map(i => i.emailId)).toEqual(['carried-over', 'first', 'second']);
  });
});

describe('emailTriageItemRepository.markBriefed', () => {
  it('marks only the owner items, so the rest stay pending for the next brief', async () => {
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'a' }));
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'b' }));
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'c', userId: 'user-other' }));

    expect(await emailTriageItemRepository.markBriefed('user-me', ['a', 'c'], new Date())).toBe(1);
    const pending = await emailTriageItemRepository.listPending('user-me', new Date(Date.now() + 1000), 10);
    expect(pending.map(i => i.emailId)).toEqual(['b']);
  });
});

describe('emailTriageItemRepository.upsertForEmail duplicate key', () => {
  it('reports created: false when a concurrent upsert wins the unique index', async () => {
    const spy = vi.spyOn(EmailTriageItemModel, 'updateOne').mockRejectedValueOnce({ code: 11000 });
    try {
      expect(await emailTriageItemRepository.upsertForEmail(item())).toEqual({ created: false });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('emailTriageItemRepository.storedEmailIds', () => {
  it('returns only the owner emails that still have a triage item', async () => {
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'a' }));
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'c', userId: 'user-other' }));

    expect(await emailTriageItemRepository.storedEmailIds('user-me', ['a', 'b', 'c'])).toEqual(['a']);
  });
});

describe('emailTriageItemRepository.deleteByEmailIds', () => {
  it('deletes only the owner items for the given emails', async () => {
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'a' }));
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'b' }));
    await emailTriageItemRepository.upsertForEmail(item({ emailId: 'c', userId: 'user-other' }));

    expect(await emailTriageItemRepository.deleteByEmailIds('user-me', ['a', 'c'])).toBe(1);
    expect((await EmailTriageItemModel.find({}).lean()).map(i => i.emailId).sort()).toEqual(['b', 'c']);
  });
});
