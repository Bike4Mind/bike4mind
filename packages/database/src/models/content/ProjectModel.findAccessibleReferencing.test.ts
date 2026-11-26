import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Project, projectRepository } from './ProjectModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Project.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Project.deleteMany({}, { hardDelete: true });
});

const MEMBER = { id: 'member', groups: ['group-1'] };

const makeProject = (name: string, overrides: Record<string, unknown> = {}) =>
  Project.create({
    name,
    userId: 'owner',
    sessionIds: [],
    fileIds: [],
    systemPrompts: [],
    users: [{ userId: MEMBER.id, permissions: ['read'] }],
    groups: [],
    ...overrides,
  });

const names = (projects: { name: string }[]) => projects.map(p => p.name).sort();

describe('ProjectRepository.findAccessibleReferencing', () => {
  it('returns readable projects holding the file in fileIds or systemPrompts', async () => {
    await makeProject('file', { fileIds: ['file-1'] });
    await makeProject('prompt', { systemPrompts: [{ fileId: 'file-1', enabled: true }] });
    await makeProject('other-file', { fileIds: ['file-2'] });
    await makeProject('unreadable', { fileIds: ['file-1'], users: [] });
    await makeProject('group', {
      fileIds: ['file-1'],
      users: [],
      groups: [{ groupId: 'group-1', permissions: ['read'] }],
    });
    await makeProject('own', { userId: MEMBER.id, users: [], fileIds: ['file-1'] });
    const deleted = await makeProject('deleted', { fileIds: ['file-1'] });
    await Project.updateOne({ _id: deleted._id }, { deletedAt: new Date() });

    const found = await projectRepository.findAccessibleReferencing(MEMBER, { fileId: 'file-1' });

    expect(names(found)).toEqual(['file', 'group', 'own', 'prompt']);
    expect(found.every(p => typeof p.id === 'string')).toBe(true);
  });

  it('returns readable projects holding the session', async () => {
    await makeProject('session', { sessionIds: ['session-1'] });
    await makeProject('file-only', { fileIds: ['session-1'] });
    await makeProject('unreadable', { sessionIds: ['session-1'], users: [] });

    const found = await projectRepository.findAccessibleReferencing(MEMBER, { sessionId: 'session-1' });

    expect(names(found)).toEqual(['session']);
  });
});
