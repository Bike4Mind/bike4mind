import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteType, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { cancelInvite } from './cancel';

/**
 * Authority tests for cancelInvite, which zeroes `remaining` on EVERY invite for a document and
 * returns those invites (carrying the document name and the pending recipient list). Each
 * InviteType needs its own arm; a type with no arm must fail closed rather than fall through to
 * the write.
 */
describe('sharingService - cancelInvite authority', () => {
  const CALLER_ID = 'caller-1';
  const DOC_ID = 'doc-1';

  const asUser = (id = CALLER_ID) => ({ id, email: 'c@example.com', isAdmin: false }) as IUserDocument;

  let db: any;

  const anInvite = () => ({
    id: 'invite-1',
    documentId: DOC_ID,
    name: 'Confidential Project',
    remaining: 5,
    recipients: { pending: ['victim@example.com'], accepted: [], refused: [] },
  });

  beforeEach(() => {
    db = {
      invites: {
        findAllByDocumentId: vi.fn(async () => [anInvite()]),
        update: vi.fn(),
      },
      users: { findById: vi.fn() },
      sessions: { findByIdAndUserId: vi.fn(async () => null) },
      fabFiles: { findByIdAndUserId: vi.fn(async () => null) },
      organizations: { findById: vi.fn(), shareable: { findShareAccessById: vi.fn(async () => null) } },
      projects: { shareable: { findShareAccessById: vi.fn(async () => null) } },
      groups: { findById: vi.fn(async () => null) },
    };
  });

  const cancel = (type: InviteType, user = asUser()) => cancelInvite(user, { id: DOC_ID, type } as any, { db });

  it('cancels project invites for a caller with share access', async () => {
    const project = { id: DOC_ID, name: 'Confidential Project' };
    db.projects.shareable.findShareAccessById = vi.fn(async () => project);

    const result = await cancel(InviteType.Project);

    expect(db.projects.shareable.findShareAccessById).toHaveBeenCalledWith(asUser(), DOC_ID);
    expect(result[0].remaining).toBe(0);
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('rejects a project cancel from a caller with no share access, and performs no write', async () => {
    // findShareAccessById already returns null in the default mock.
    await expect(cancel(InviteType.Project)).rejects.toThrow(NotFoundError);

    expect(db.invites.update).not.toHaveBeenCalled();
    // The invite list is never even read, so the document name and pending recipients are not
    // returned to a caller who cannot see the project.
    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
  });

  it('fails closed for an InviteType with no authorization arm', async () => {
    // Tool has no arm. It must not reach the write, and must not disclose the invite list.
    await expect(cancel(InviteType.Tool)).rejects.toThrow(NotFoundError);

    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('still authorizes the pre-existing arms', async () => {
    await expect(cancel(InviteType.FabFile)).rejects.toThrow(NotFoundError);
    await expect(cancel(InviteType.Session)).rejects.toThrow(NotFoundError);
    await expect(cancel(InviteType.Organization)).rejects.toThrow(NotFoundError);
    await expect(cancel(InviteType.Group)).rejects.toThrow(NotFoundError);

    expect(db.invites.update).not.toHaveBeenCalled();
  });
});
