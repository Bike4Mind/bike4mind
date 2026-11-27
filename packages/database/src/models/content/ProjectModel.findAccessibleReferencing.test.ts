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

  it('finds and removes stored hexadecimal spellings in each reference field', async () => {
    const id = '0123456789abcdef01234567';
    const stored = id.toUpperCase();
    const project = await makeProject('legacy');
    await Project.collection.updateOne(
      { _id: project._id },
      {
        $set: {
          fileIds: [stored, 'Doc-A', 'doc-a'],
          systemPrompts: [{ fileId: stored, enabled: true }],
          sessionIds: [stored, 'Session-A', 'session-a'],
        },
      }
    );

    expect(names(await projectRepository.findAccessibleReferencing(MEMBER, { fileId: id }))).toEqual(['legacy']);
    expect(names(await projectRepository.findAccessibleReferencing(MEMBER, { sessionId: id }))).toEqual(['legacy']);
    await projectRepository.pullFileReferences([id], { projectId: String(project._id) });
    await projectRepository.pullSessionReferences([id], { projectId: String(project._id) });

    const remaining = await Project.collection.findOne({ _id: project._id });
    expect(remaining?.fileIds).toEqual(['Doc-A', 'doc-a']);
    expect(remaining?.systemPrompts).toEqual([]);
    expect(remaining?.sessionIds).toEqual(['Session-A', 'session-a']);
    await projectRepository.pullFileReferences(['Doc-A'], { projectId: String(project._id) });
    await projectRepository.pullSessionReferences(['Session-A'], { projectId: String(project._id) });
    const exact = await Project.collection.findOne({ _id: project._id });
    expect(exact?.fileIds).toEqual(['doc-a']);
    expect(exact?.sessionIds).toEqual(['session-a']);
  });

  it('keeps nonhexadecimal discovery case-sensitive', async () => {
    await makeProject('upper', { fileIds: ['Doc-A'], sessionIds: ['Session-A'] });
    await makeProject('lower', { fileIds: ['doc-a'], sessionIds: ['session-a'] });

    expect(names(await projectRepository.findAccessibleReferencing(MEMBER, { fileId: 'Doc-A' }))).toEqual(['upper']);
    expect(names(await projectRepository.findAccessibleReferencing(MEMBER, { sessionId: 'Session-A' }))).toEqual([
      'upper',
    ]);
    await projectRepository.removeSession('Session-A');
    expect(names(await projectRepository.findAccessibleReferencing(MEMBER, { sessionId: 'session-a' }))).toEqual([
      'lower',
    ]);
  });

  it('includes an update-only participant only in internal grant cleanup discovery', async () => {
    await makeProject('update-only', { fileIds: ['file-1'], users: [{ userId: MEMBER.id, permissions: ['update'] }] });
    await makeProject('unrelated', { fileIds: ['file-1'], users: [] });

    expect(await projectRepository.findAccessibleReferencing(MEMBER, { fileId: 'file-1' })).toEqual([]);
    expect(names(await projectRepository.findParticipatingReferencing(MEMBER, { fileId: 'file-1' }))).toEqual([
      'update-only',
    ]);
  });
});
