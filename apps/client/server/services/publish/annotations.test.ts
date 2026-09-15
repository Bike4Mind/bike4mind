import { describe, it, expect } from 'vitest';
import { canAnnotate, toAnnotationDto, toPublishUser, type AnnotationLean } from './annotations';
import type { PublishUser } from './checkScopePermission';

const owner: PublishUser = { id: 'u-owner', username: 'owner', isAdmin: false, organizationId: null };
const viewer: PublishUser = { id: 'u-viewer', username: 'viewer', isAdmin: false, organizationId: null };
const admin: PublishUser = { id: 'u-admin', username: 'admin', isAdmin: true, organizationId: null };

describe('canAnnotate', () => {
  it('always denies anonymous callers regardless of policy', () => {
    expect(canAnnotate({ commentPolicy: 'open', ownerId: 'u-owner' }, undefined, true)).toBe(false);
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, undefined, true)).toBe(false);
    expect(canAnnotate({ commentPolicy: 'none', ownerId: 'u-owner' }, undefined, true)).toBe(false);
  });

  it('denies everyone when policy is none (read-only)', () => {
    expect(canAnnotate({ commentPolicy: 'none', ownerId: 'u-owner' }, owner, true)).toBe(false);
    expect(canAnnotate({ commentPolicy: 'none', ownerId: 'u-owner' }, admin, true)).toBe(false);
  });

  it('open policy lets any authenticated viewer who passed the visibility gate', () => {
    expect(canAnnotate({ commentPolicy: 'open', ownerId: 'u-owner' }, viewer, true)).toBe(true);
    // but not if they failed the visibility gate
    expect(canAnnotate({ commentPolicy: 'open', ownerId: 'u-owner' }, viewer, false)).toBe(false);
  });

  it('restricted policy is owner/admin only (allowlist deferred)', () => {
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, owner, true)).toBe(true);
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, admin, true)).toBe(true);
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, viewer, true)).toBe(false);
  });
});

describe('toPublishUser', () => {
  it('returns undefined when there is no user id', () => {
    expect(toPublishUser(undefined)).toBeUndefined();
  });

  it('narrows an Express user to the PublishUser shape', () => {
    const u = { id: 'u1', username: 'bob', isAdmin: true, organizationId: 'org1' } as unknown as Express.User;
    expect(toPublishUser(u)).toEqual({ id: 'u1', username: 'bob', isAdmin: true, organizationId: 'org1' });
  });
});

describe('toAnnotationDto', () => {
  it('serializes dates to ISO strings and never leaks internal fields', () => {
    const created = new Date('2026-06-16T12:00:00.000Z');
    const row: AnnotationLean = {
      _id: { toString: () => 'a1' },
      publicId: 'pub1',
      kind: 'comment',
      authorId: 'u1',
      authorDisplayName: 'Bob',
      body: 'looks great',
      anchor: { x: 0.5, y: 0.25 },
      threadRootId: null,
      createdAt: created,
      resolvedAt: null,
    };
    const dto = toAnnotationDto(row);
    expect(dto).toMatchObject({
      id: 'a1',
      publicId: 'pub1',
      kind: 'comment',
      body: 'looks great',
      anchor: { x: 0.5, y: 0.25 },
      createdAt: '2026-06-16T12:00:00.000Z',
      resolvedAt: null,
    });
    // No deletedAt / deletedBy / updatedAt leak into the public DTO.
    expect(Object.keys(dto)).not.toContain('deletedAt');
    expect(Object.keys(dto)).not.toContain('deletedBy');
  });
});
