import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Session, sessionRepository } from '../SessionModel';

describe('SessionModel.addAutoAddedTools', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const createSession = async () => {
    const session = await Session.create({
      name: 'chat',
      userId: 'user-1',
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });
    return session.id as string;
  };

  const stored = async (id: string) => (await Session.findById(id).lean())?.autoAddedTools ?? [];

  it('starts empty', async () => {
    expect(await stored(await createSession())).toEqual([]);
  });

  it('adds tools without duplicating ones already there', async () => {
    const id = await createSession();

    await sessionRepository.addAutoAddedTools(id, ['blog_draft', 'skill']);
    await sessionRepository.addAutoAddedTools(id, ['skill', 'blog_edit']);

    expect([...(await stored(id))].sort()).toEqual(['blog_draft', 'blog_edit', 'skill']);
  });

  it("only ever grows: concurrent writers keep one another's entries", async () => {
    const id = await createSession();

    await Promise.all([
      sessionRepository.addAutoAddedTools(id, ['blog_draft']),
      sessionRepository.addAutoAddedTools(id, ['skill']),
      sessionRepository.addAutoAddedTools(id, ['create_data_lake']),
    ]);

    expect([...(await stored(id))].sort()).toEqual(['blog_draft', 'create_data_lake', 'skill']);
  });

  it('does nothing for an empty list', async () => {
    const id = await createSession();

    await sessionRepository.addAutoAddedTools(id, []);

    expect(await stored(id)).toEqual([]);
  });
});
