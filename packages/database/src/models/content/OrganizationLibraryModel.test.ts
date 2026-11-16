import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { OrganizationLibrary } from './OrganizationLibraryModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('organization-owned library snapshots', () => {
  it.each(['agent', 'skill', 'prompt', 'template'] as const)(
    'retains %s content independently of its author and source',
    async kind => {
      const source = await mongoose.connection
        .collection('library_test_sources')
        .insertOne({ userId: 'author', name: kind });
      const item = await OrganizationLibrary.create({
        organizationId: 'org-a',
        kind,
        name: kind,
        description: '',
        pinned: false,
        definition: { name: kind, body: 'Retained instructions' },
      });
      await mongoose.connection.collection('library_test_sources').deleteOne({ _id: source.insertedId });
      const stored = await OrganizationLibrary.findOne({ _id: item._id, organizationId: 'org-a' });
      expect(stored?.definition).toMatchObject({ name: kind, body: 'Retained instructions' });
      expect(stored?.toJSON()).not.toHaveProperty('userId');
      expect(await OrganizationLibrary.findOne({ _id: item._id, organizationId: 'org-b' })).toBeNull();
      expect(
        await OrganizationLibrary.findOneAndUpdate(
          { _id: item._id, organizationId: 'org-b' },
          { pinned: true },
          { new: true }
        )
      ).toBeNull();
      await OrganizationLibrary.updateOne({ _id: item._id, organizationId: 'org-a' }, { pinned: true });
      expect((await OrganizationLibrary.findById(item._id))?.pinned).toBe(true);
    }
  );
});
