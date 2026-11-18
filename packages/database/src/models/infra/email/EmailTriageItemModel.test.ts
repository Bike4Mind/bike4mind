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

describe('emailTriageItemRepository.listForWindow', () => {
  it('returns the owner items created in [start, end), oldest first', async () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    await EmailTriageItemModel.insertMany(
      [
        { ...item({ emailId: 'before' }), createdAt: at(-1) },
        { ...item({ emailId: 'second' }), createdAt: at(500) },
        { ...item({ emailId: 'first' }), createdAt: at(0) },
        { ...item({ emailId: 'at-end' }), createdAt: at(1000) },
        { ...item({ emailId: 'other-user', userId: 'user-other' }), createdAt: at(100) },
      ],
      { timestamps: false } as Parameters<typeof EmailTriageItemModel.insertMany>[1]
    );

    const listed = await emailTriageItemRepository.listForWindow('user-me', t0, at(1000), 10);

    expect(listed.map(i => i.emailId)).toEqual(['first', 'second']);
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
