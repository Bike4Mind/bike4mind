import { describe, it, expect } from 'vitest';
import { canUserReadArtifact } from './get';

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
