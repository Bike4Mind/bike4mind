import { describe, expect, it } from 'vitest';
import { ArtifactResourceSchema, ArtifactVersionSchema } from '@bike4mind/common';
import { toPublicArtifact, toPublicArtifactVersion } from './toPublicArtifact';

const FULL_DOC = {
  _id: '65a000000000000000000001',
  id: 'mermaid-signup-flow-1',
  type: 'mermaid' as const,
  title: 'Signup flow',
  description: 'How a user signs up',
  version: 3,
  versionTag: 'v3',
  status: 'published',
  tags: ['onboarding'],
  sessionId: 's1',
  projectId: 'p1',
  visibility: 'private',
  createdAt: new Date('2026-10-01T12:00:00.000Z'),
  updatedAt: '2026-10-02T09:30:00.000Z',
  // Everything below must never reach the wire.
  userId: 'owner-1',
  organizationId: 'org-1',
  permissions: { canRead: ['u2'], canWrite: [], canDelete: [], isPublic: false },
  contentId: 'c1',
  currentVersionId: 'v1',
  contentHash: 'abc',
  contentSize: 10,
  metadata: { aiGenerated: true },
  deletedAt: null,
  sourceQuestId: 'q1',
  parentArtifactId: 'a0',
};

describe('toPublicArtifact', () => {
  it('publishes exactly the allowlisted fields', () => {
    const out = toPublicArtifact(FULL_DOC, 'graph TD; A-->B');

    expect(Object.keys(out).sort()).toEqual(
      [
        'content',
        'created_at',
        'description',
        'id',
        'project_id',
        'session_id',
        'status',
        'tags',
        'title',
        'type',
        'updated_at',
        'version',
        'version_tag',
        'visibility',
      ].sort()
    );
    expect(out).toMatchObject({
      id: 'mermaid-signup-flow-1',
      created_at: '2026-10-01T12:00:00.000Z',
      updated_at: '2026-10-02T09:30:00.000Z',
      content: 'graph TD; A-->B',
    });
    expect(ArtifactResourceSchema.safeParse(out).success).toBe(true);
  });

  it('turns absent optionals into null and keeps a list item content-free', () => {
    const out = toPublicArtifact(
      { id: 'a', type: 'html', title: 't', createdAt: FULL_DOC.createdAt, updatedAt: FULL_DOC.createdAt },
      null
    );

    expect(out).toMatchObject({
      description: null,
      version: 1,
      version_tag: null,
      status: 'draft',
      tags: [],
      session_id: null,
      project_id: null,
      visibility: 'private',
      content: null,
    });
    expect(ArtifactResourceSchema.safeParse(out).success).toBe(true);
  });
});

describe('toPublicArtifactVersion', () => {
  it('publishes exactly the allowlisted fields', () => {
    const out = toPublicArtifactVersion(
      {
        _id: 'v1',
        artifactId: 'a',
        version: 2,
        versionTag: undefined,
        changeDescription: 'Updated artifact content',
        contentId: 'c1',
        createdBy: 'owner-1',
        isActive: true,
        createdAt: FULL_DOC.createdAt,
      } as Parameters<typeof toPublicArtifactVersion>[0],
      null
    );

    expect(out).toEqual({
      version: 2,
      version_tag: null,
      change_description: 'Updated artifact content',
      created_at: '2026-10-01T12:00:00.000Z',
      content: null,
    });
    expect(ArtifactVersionSchema.safeParse(out).success).toBe(true);
  });
});
