import { describe, it, expect } from 'vitest';
import type { IArtifactDocument, IArtifactVersionDocument } from '@bike4mind/common';
import { toArtifactViewerView, toArtifactViewerVersion } from './toArtifactViewerView';

describe('toArtifactViewerView', () => {
  it('emits only the allowlisted keys', () => {
    const doc = {
      _id: 'm1',
      id: 'a1',
      type: 'html',
      title: 'T',
      version: 1,
      status: 'draft',
      tags: [],
      visibility: 'public',
      contentHash: 'h',
      contentSize: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: 'u',
      organizationId: 'o',
      projectId: 'p',
      sessionId: 's',
      permissions: { canRead: ['x'], canWrite: [], canDelete: [], isPublic: true },
      sourceQuestId: 'q',
      somethingAddedLater: 'secret',
    } as unknown as IArtifactDocument;

    const view = toArtifactViewerView(doc) as Record<string, unknown>;
    const defined = Object.keys(view).filter(k => view[k] !== undefined);
    expect(defined.sort()).toEqual(
      [
        'contentHash',
        'contentSize',
        'createdAt',
        'id',
        'status',
        'tags',
        'title',
        'type',
        'updatedAt',
        'version',
        'visibility',
      ].sort()
    );
  });

  it('drops the author from a version', () => {
    const v = {
      _id: 'v',
      artifactId: 'a',
      version: 1,
      createdBy: 'u',
      changes: [],
      isActive: true,
    } as unknown as IArtifactVersionDocument;
    expect(toArtifactViewerVersion(v)).not.toHaveProperty('createdBy');
    expect(toArtifactViewerVersion(v)).toMatchObject({ _id: 'v', version: 1 });
  });
});
