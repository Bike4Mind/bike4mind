// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('@bike4mind/services', () => ({
  artifactService: { get: (...a: unknown[]) => mockGet(...a) },
}));
vi.mock('@bike4mind/server-utils/artifacts/artifactAccess', async () => {
  const { NotFoundError, UnauthorizedError } = await import('@bike4mind/server-utils/utils/errors');
  return {
    ARTIFACT_DB: {},
    hideArtifactDenial: async <T>(call: Promise<T>) => {
      try {
        return await call;
      } catch (err) {
        if (err instanceof UnauthorizedError) throw new NotFoundError('Artifact not found');
        throw err;
      }
    },
  };
});

import { loadArtifactForPublish, toPublishedArtifactResource } from './publishStoredArtifactHelpers';

const stored = { id: 'art-1', type: 'mermaid', title: 'Signup flow', version: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://app.example.com';
});

describe('loadArtifactForPublish', () => {
  it('returns the artifact and its current content for the owner', async () => {
    mockGet.mockResolvedValue({ access: 'owner', artifact: stored, content: { content: 'graph TD; A-->B' } });
    await expect(loadArtifactForPublish('user-1', 'art-1')).resolves.toEqual({
      artifact: { id: 'art-1', type: 'mermaid', title: 'Signup flow', version: 2 },
      content: 'graph TD; A-->B',
    });
  });

  it.each(['shared', 'public'] as const)('answers 404 for a caller with only %s access', async access => {
    mockGet.mockResolvedValue({ access, artifact: stored, content: { content: 'x' } });
    await expect(loadArtifactForPublish('user-2', 'art-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 404 when the service denies the read', async () => {
    const { UnauthorizedError } = await import('@bike4mind/server-utils/utils/errors');
    mockGet.mockRejectedValue(new UnauthorizedError('Access denied'));
    await expect(loadArtifactForPublish('user-2', 'art-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 422 when the artifact has no content to publish', async () => {
    mockGet.mockResolvedValue({ access: 'owner', artifact: stored, content: null });
    await expect(loadArtifactForPublish('user-1', 'art-1')).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('toPublishedArtifactResource', () => {
  it('maps the page to the snake_case wire shape with an absolute url and never a passphrase', () => {
    const resource = toPublishedArtifactResource('art-1', {
      publicId: 'abc123def456',
      slug: 'signup-flow',
      path: '/p/u/user-1/signup-flow',
      visibility: 'public',
      accessGateKind: 'passphrase',
      publishedVersion: 2,
      publishedAt: new Date('2026-10-03T08:00:00.000Z'),
    });
    expect(resource).toEqual({
      artifact_id: 'art-1',
      public_id: 'abc123def456',
      url: 'https://app.example.com/p/u/user-1/signup-flow',
      slug: 'signup-flow',
      visibility: 'public',
      access_gate: { kind: 'passphrase' },
      published_version: 2,
      published_at: '2026-10-03T08:00:00.000Z',
    });
  });

  it('reports no gate as null', () => {
    const resource = toPublishedArtifactResource('art-1', {
      publicId: 'p',
      slug: 'signup-flow',
      path: '/p/u/u/signup-flow',
      visibility: 'private',
      accessGateKind: null,
      publishedVersion: 1,
      publishedAt: new Date(0),
    });
    expect(resource.access_gate).toBeNull();
  });
});
