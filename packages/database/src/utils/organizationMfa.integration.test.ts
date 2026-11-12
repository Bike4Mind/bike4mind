import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withOrganizationMfaContext } from '@bike4mind/db-core';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../__test__/createMongoServer';
import { Organization } from '../models/infra/admin/OrganizationModel';
import { Session } from '../models/auth/SessionModel';
import { Project } from '../models/content/ProjectModel';
import { Artifact } from '../models/content/ArtifactModel';
import { ArtifactVersion } from '../models/content/ArtifactVersionModel';
import { PublishedArtifact } from '../models/content/PublishedArtifactModel';
import { agentExecutionRepository } from '../models/billing/AgentExecutionModel';
import { createServer } from 'node:http';
import { once } from 'node:events';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('persisted organization MFA content boundary', () => {
  it(
    'allows lifecycle claims outside the resource context while retaining session enforcement',
    async () => {
      const userId = String(new mongoose.Types.ObjectId());
      const org = await Organization.create({
        name: 'Queued MFA',
        userId,
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      const session = await Session.create({
        name: 'queued',
        userId,
        organizationId: org.id,
        firstCreated: new Date(),
        lastUpdated: new Date(),
      });
      const execution = await agentExecutionRepository.create({
        userId,
        sessionId: session.id,
        questId: String(new mongoose.Types.ObjectId()),
        query: 'queued',
        model: 'test',
        status: 'continuing',
      });
      await withOrganizationMfaContext(
        () => userId,
        async () => {
          expect(await agentExecutionRepository.claimExecution(execution.id, ['continuing'], 'running')).toBe(false);
          expect(
            await withOrganizationMfaContext(
              () => undefined,
              () => agentExecutionRepository.claimExecution(execution.id, ['continuing'], 'running')
            )
          ).toBe(true);
          expect(await Session.findById(session.id)).toBeNull();
        }
      );
      await agentExecutionRepository.markFailed(execution.id, { message: 'Policy refusal' });
      expect((await agentExecutionRepository.findById(execution.id))?.status).toBe('failed');
    },
    MONGO_TEST_TIMEOUT_MS
  );

  it(
    'measures repeated child reads with thousands of bound parents',
    async () => {
      const userId = String(new mongoose.Types.ObjectId());
      const org = await Organization.create({
        name: 'Volume MFA',
        userId,
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      await Project.collection.insertMany(
        Array.from({ length: 5000 }, (_, index) => ({ name: `volume-${index}`, userId, organizationId: org.id }))
      );
      const collections = vi.spyOn(mongoose.connection.db!, 'collection');
      const started = performance.now();
      await withOrganizationMfaContext(
        () => userId,
        async () => {
          for (let index = 0; index < 20; index++)
            expect(await ArtifactVersion.find({ createdBy: userId }).lean()).toEqual([]);
        }
      );
      console.info(
        `organization-mfa-volume: 5000 bound projects, 20 child reads, ${Math.round(performance.now() - started)}ms`
      );
      expect(collections.mock.calls.some(([name]) => name === Project.collection.collectionName)).toBe(false);
      collections.mockRestore();
    },
    MONGO_TEST_TIMEOUT_MS
  );

  it(
    'denies bound by-id, list, aggregate and mutation paths while retaining personal data',
    async () => {
      const userId = new mongoose.Types.ObjectId();
      await mongoose.connection.db!.collection('users').insertOne({ _id: userId, username: String(userId), mfa: null });
      const org = await Organization.create({
        name: 'MFA test',
        userId: String(userId),
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      const bound = await Project.create({ name: 'bound', userId: String(userId), organizationId: org.id });
      const personal = await Project.create({ name: 'personal', userId: String(userId) });
      const session = await Session.create({
        name: 'bound',
        userId: String(userId),
        organizationId: org.id,
        firstCreated: new Date(),
        lastUpdated: new Date(),
      });
      await withOrganizationMfaContext(
        () => String(userId),
        async () => {
          expect(await Project.findById(bound.id)).toBeNull();
          expect(await Session.findById(session.id)).toBeNull();
          expect((await Project.find({ userId: String(userId) })).map(row => row.id)).toEqual([personal.id]);
          expect(await Project.countDocuments({ userId: String(userId) })).toBe(1);
          expect(await Project.aggregate([{ $match: { userId: String(userId) } }, { $count: 'count' }])).toEqual([
            { count: 1 },
          ]);
          const joined = await Project.aggregate([
            { $match: { _id: personal._id } },
            {
              $lookup: {
                from: Project.collection.collectionName,
                pipeline: [{ $match: { userId: String(userId) } }],
                as: 'projects',
              },
            },
          ]);
          expect(joined[0].projects.map((row: { name: string }) => row.name)).toEqual(['personal']);
          expect((await Project.updateOne({ _id: bound.id }, { $set: { name: 'changed' } })).matchedCount).toBe(0);
          expect((await Project.deleteOne({ _id: bound.id })).deletedCount).toBe(0);
          expect(
            (
              await Project.bulkWrite([
                { updateOne: { filter: { _id: bound._id }, update: { $set: { name: 'bulk changed' } } } },
              ])
            ).matchedCount
          ).toBe(0);
          expect(
            (
              await Project.bulkWrite([
                { updateOne: { filter: { _id: personal._id }, update: { $set: { description: 'personal bulk' } } } },
              ])
            ).matchedCount
          ).toBe(1);
          expect((await Project.findById(personal.id))?.name).toBe('personal');
          await expect(
            Project.updateOne({ _id: personal.id }, { $rename: { description: 'organizationId' } })
          ).rejects.toThrow('MFA');
          await expect(
            Project.create({ name: 'new bound', userId: String(userId), organizationId: org.id })
          ).rejects.toThrow('MFA');
        }
      );
      await withOrganizationMfaContext(
        () => undefined,
        async () => {
          expect(await Project.findById(bound.id)).not.toBeNull();
          expect(await Project.findById(personal.id)).not.toBeNull();
        }
      );
      await mongoose.connection
        .db!.collection('users')
        .updateOne({ _id: userId }, { $set: { mfa: { totpEnabled: true } } });
      await withOrganizationMfaContext(
        () => String(userId),
        async () => {
          expect(await Project.findById(bound.id)).not.toBeNull();
          expect(await Session.findById(session.id)).not.toBeNull();
        }
      );
      await mongoose.connection
        .db!.collection('users')
        .updateOne({ _id: userId }, { $set: { 'mfa.totpEnabled': false } });
      await Organization.updateOne(
        { _id: org.id },
        { $set: { 'mfaPolicy.enforceAfter': new Date(Date.now() + 60_000) } }
      );
      await withOrganizationMfaContext(
        () => String(userId),
        async () => {
          expect(await Project.findById(bound.id)).not.toBeNull();
        }
      );
    },
    MONGO_TEST_TIMEOUT_MS
  );

  it(
    'follows inherited artifact bindings and checks new child records',
    async () => {
      const userId = String(new mongoose.Types.ObjectId());
      const org = await Organization.create({
        name: 'Inherited MFA',
        userId,
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      const project = await Project.create({ name: 'inherited', userId, organizationId: org.id });
      const artifactId = 'inherited-mfa-artifact';
      await Artifact.collection.insertOne({ id: artifactId, projectId: project.id, userId });
      const version = await ArtifactVersion.create({
        artifactId,
        version: 1,
        contentId: new mongoose.Types.ObjectId(),
        createdBy: userId,
      });
      const collection = mongoose.connection.db!.collection(Project.collection.collectionName);
      const parentReads = vi.spyOn(Object.getPrototypeOf(collection) as typeof collection, 'find');
      await withOrganizationMfaContext(
        () => userId,
        async () => {
          expect(await Artifact.findOne({ id: artifactId })).toBeNull();
          expect(await ArtifactVersion.findById(version._id)).toBeNull();
          expect(await ArtifactVersion.aggregate([{ $match: { _id: version._id } }])).toEqual([]);
          await expect(
            ArtifactVersion.bulkWrite([
              {
                insertOne: {
                  document: { artifactId, version: 4, contentId: new mongoose.Types.ObjectId(), createdBy: userId },
                },
              },
            ])
          ).rejects.toThrow('MFA');
          await expect(
            ArtifactVersion.create({
              artifactId,
              version: 2,
              contentId: new mongoose.Types.ObjectId(),
              createdBy: userId,
            })
          ).rejects.toThrow('MFA');
          await expect(
            ArtifactVersion.insertMany([
              { artifactId, version: 3, contentId: new mongoose.Types.ObjectId(), createdBy: userId },
            ])
          ).rejects.toThrow('MFA');
          await expect(
            ArtifactVersion.updateOne(
              { _id: new mongoose.Types.ObjectId() },
              { $set: { artifactId } },
              { upsert: true }
            )
          ).rejects.toThrow('MFA');
        }
      );
      expect(parentReads.mock.calls).toContainEqual([
        { $or: [{ _id: project._id }] },
        expect.objectContaining({ limit: 2, batchSize: 1 }),
      ]);
      parentReads.mockRestore();
    },
    MONGO_TEST_TIMEOUT_MS
  );

  it(
    'requires a trusted matching service context and reloads decisions after authentication',
    async () => {
      const userId = new mongoose.Types.ObjectId();
      const org = await Organization.create({
        name: 'Service MFA',
        userId: String(userId),
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      await mongoose.connection.db!.collection('users').insertOne({
        _id: userId,
        username: String(userId),
        isSystem: true,
        serviceAccountOrganizationId: org.id,
      });
      const project = await Project.create({ name: 'service', userId: String(userId), organizationId: org.id });
      await withOrganizationMfaContext(
        () => String(userId),
        async () => {
          expect(await Project.findById(project.id)).toBeNull();
        }
      );
      await withOrganizationMfaContext(
        () => String(userId),
        async () => {
          expect(await Project.findById(project.id)).not.toBeNull();
        },
        () => org.id
      );
      let principal: string | undefined;
      await withOrganizationMfaContext(
        () => principal,
        async () => {
          expect(await Project.findById(project.id)).not.toBeNull();
          principal = String(userId);
          expect(await Project.findById(project.id)).toBeNull();
        }
      );
    },
    MONGO_TEST_TIMEOUT_MS
  );

  it(
    'leaves public visibility to existing gates and applies policy only to current members',
    async () => {
      const memberId = String(new mongoose.Types.ObjectId());
      const outsiderId = String(new mongoose.Types.ObjectId());
      const org = await Organization.create({
        name: 'Member MFA',
        userId: String(new mongoose.Types.ObjectId()),
        users: [{ userId: memberId, permissions: ['read'] }],
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      const project = await Project.create({ name: 'shared', userId: memberId, organizationId: org.id });
      const publication = await PublishedArtifact.create({
        publicId: 'mfa-public-view',
        tier: 'project',
        scopeId: project.id,
        slug: 'mfa-public-view',
        title: 'Public view',
        ownerId: memberId,
        visibility: 'public',
        source: { kind: 'reply', sessionId: String(new mongoose.Types.ObjectId()) },
      });
      for (const principal of [undefined, outsiderId]) {
        await withOrganizationMfaContext(
          () => principal,
          async () => {
            expect(
              await PublishedArtifact.findOne({ publicId: publication.publicId, visibility: 'public' })
            ).not.toBeNull();
            expect(await Project.findById(project.id)).not.toBeNull();
          }
        );
      }
      await withOrganizationMfaContext(
        () => memberId,
        async () => {
          expect(await Project.findById(project.id)).toBeNull();
          expect(await PublishedArtifact.findById(publication.id)).toBeNull();
        }
      );
      await Organization.updateOne({ _id: org.id }, { $set: { 'users.0.permissions': ['delete'] } });
      await withOrganizationMfaContext(
        () => memberId,
        async () => expect(await Project.findById(project.id)).not.toBeNull()
      );
    },
    MONGO_TEST_TIMEOUT_MS
  );

  it(
    'enforces the same boundary over HTTP reads and writes without restricting personal access',
    async () => {
      const userId = new mongoose.Types.ObjectId();
      await mongoose.connection.db!.collection('users').insertOne({ _id: userId, username: String(userId), mfa: null });
      const org = await Organization.create({
        name: 'HTTP MFA',
        userId: String(userId),
        mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
      });
      const bound = await Project.create({ name: 'HTTP bound', userId: String(userId), organizationId: org.id });
      const personal = await Project.create({ name: 'HTTP personal', userId: String(userId) });
      const http = createServer((request, response) => {
        void withOrganizationMfaContext(
          () => String(userId),
          async () => {
            const id = request.url?.slice(1);
            const project =
              request.method === 'PATCH'
                ? await Project.findOneAndUpdate({ _id: id }, { $set: { description: 'HTTP changed' } }, { new: true })
                : await Project.findById(id);
            response.writeHead(project ? 200 : 404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(project));
          }
        ).catch(() => {
          response.writeHead(500);
          response.end();
        });
      });
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('HTTP test address unavailable');
      const url = `http://127.0.0.1:${address.port}`;
      try {
        expect((await fetch(`${url}/${bound.id}`)).status).toBe(404);
        expect((await fetch(`${url}/${bound.id}`, { method: 'PATCH' })).status).toBe(404);
        expect((await fetch(`${url}/${personal.id}`)).status).toBe(200);
        expect((await fetch(`${url}/${personal.id}`, { method: 'PATCH' })).status).toBe(200);
        await mongoose.connection
          .db!.collection('users')
          .updateOne({ _id: userId }, { $set: { mfa: { totpEnabled: true } } });
        expect((await fetch(`${url}/${bound.id}`)).status).toBe(200);
        expect((await fetch(`${url}/${bound.id}`, { method: 'PATCH' })).status).toBe(200);
      } finally {
        await new Promise<void>((resolve, reject) => http.close(error => (error ? reject(error) : resolve())));
      }
    },
    MONGO_TEST_TIMEOUT_MS
  );
});
