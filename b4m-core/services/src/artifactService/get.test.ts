import { describe, it, expect, vi } from 'vitest';
import { canUserReadArtifact, get } from './get';

describe('canUserReadArtifact', () => {
  const artifact = (overrides: Record<string, unknown> = {}) => ({
    userId: 'owner',
    visibility: 'private',
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    ...overrides,
  });

  it.each([
    ['the owner', 'owner', artifact()],
    ['a read sharee', 'u2', artifact({ permissions: { canRead: ['u2'], canWrite: [], canDelete: [] } })],
    ['anyone on a public artifact', 'u2', artifact({ visibility: 'public' })],
    ['anyone on an isPublic artifact', 'u2', artifact({ permissions: { isPublic: true } })],
  ])('admits %s', (_label, userId, doc) => {
    expect(canUserReadArtifact(userId, doc)).toBe(true);
  });

  it.each([
    ['a write-only sharee', artifact({ permissions: { canRead: [], canWrite: ['u2'], canDelete: [] } })],
    ['a stranger', artifact()],
  ])('rejects %s', (_label, doc) => {
    expect(canUserReadArtifact('u2', doc)).toBe(false);
  });
});

describe('get by caller', () => {
  const stored = {
    _id: 'm1',
    id: 'artifact_react_x_1_0',
    type: 'react',
    title: 'T',
    version: 2,
    status: 'draft',
    tags: ['a'],
    visibility: 'public',
    metadata: { language: 'ts' },
    contentHash: 'h',
    contentSize: 3,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    userId: 'owner',
    organizationId: 'org',
    sessionId: 'sess',
    projectId: 'proj',
    permissions: { canRead: ['sharee'], canWrite: [], canDelete: [], isPublic: false },
  };
  const versionDoc = { _id: 'v1', artifactId: stored.id, version: 1, createdBy: 'owner', changes: [] };

  const call = (userId: string, doc: Record<string, unknown> = stored) => {
    const db = {
      artifacts: { findOne: vi.fn().mockResolvedValue(doc) },
      artifactContents: { findLatestContent: vi.fn().mockResolvedValue({ content: 'body' }) },
      artifactVersions: { findByArtifactId: vi.fn().mockResolvedValue([versionDoc]) },
    };
    return get(userId, { id: stored.id, includeContent: true, includeVersions: true }, { db } as never);
  };

  it('gives the owner the full document and version authors', async () => {
    const r = await call('owner');
    expect(r.access).toBe('owner');
    expect(r.artifact).toEqual(stored);
    expect(r.versions).toEqual([versionDoc]);
  });

  it('gives an explicit sharee on a public artifact the full document', async () => {
    const r = await call('sharee');
    expect(r.access).toBe('shared');
    expect(r.artifact).toEqual(stored);
    expect(r.versions).toEqual([versionDoc]);
  });

  it.each([
    ['visibility public', stored],
    ['isPublic', { ...stored, visibility: 'private', permissions: { ...stored.permissions, isPublic: true } }],
  ])('gives a stranger the viewer shape on %s', async (_l, doc) => {
    const r = await call('stranger', doc);
    expect(r.access).toBe('public');
    expect(r.artifact).toMatchObject({ id: stored.id, title: 'T', version: 2, metadata: { language: 'ts' } });
    for (const k of ['userId', 'permissions', 'organizationId', 'sessionId', 'projectId', '_id']) {
      expect(r.artifact).not.toHaveProperty(k);
    }
    expect(r.content).toEqual({ content: 'body' });
    expect(r.versions).toHaveLength(1);
    expect(r.versions?.[0]).not.toHaveProperty('createdBy');
  });

  it('refuses a stranger on a private artifact', async () => {
    await expect(call('stranger', { ...stored, visibility: 'private' })).rejects.toThrow('Access denied');
  });
});
