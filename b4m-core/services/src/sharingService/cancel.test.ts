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

  // Link-style invite: recipients.pending is `[]` (truthy), so it must never be decremented by an
  // email-scoped cancel that never targeted it - see the cancelInvite loop.
  const aLinkInvite = () => ({
    id: 'invite-2',
    documentId: DOC_ID,
    name: 'Confidential Project',
    remaining: 1000,
    recipients: { pending: [], accepted: [], refused: [] },
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

  const cancel = (type: InviteType, user = asUser(), email?: string) =>
    cancelInvite(user, { id: DOC_ID, type, email } as any, { db });

  it('cancels project invites for a caller with share access', async () => {
    const project = { id: DOC_ID, name: 'Confidential Project' };
    db.projects.shareable.findShareAccessById = vi.fn(async () => project);

    const result = await cancel(InviteType.Project);

    expect(db.projects.shareable.findShareAccessById).toHaveBeenCalledWith(asUser(), DOC_ID);
    expect(result[0].remaining).toBe(0);
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('cancelling one email only decrements the invite it was actually pending on', async () => {
    const project = { id: DOC_ID, name: 'Confidential Project' };
    db.projects.shareable.findShareAccessById = vi.fn(async () => project);
    db.invites.findAllByDocumentId = vi.fn(async () => [anInvite(), aLinkInvite()]);

    const result = await cancel(InviteType.Project, asUser(), 'victim@example.com');

    const targeted = result.find((invite: any) => invite.id === 'invite-1');
    const link = result.find((invite: any) => invite.id === 'invite-2');
    expect(targeted.remaining).toBe(4);
    expect(targeted.recipients.pending).not.toContain('victim@example.com');
    expect(link.remaining).toBe(1000);
    expect(link.recipients.pending).toEqual([]);
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

  it('denies every pre-existing arm when its lookup finds nothing', async () => {
    await expect(cancel(InviteType.FabFile)).rejects.toThrow(NotFoundError);
    await expect(cancel(InviteType.Session)).rejects.toThrow(NotFoundError);
    await expect(cancel(InviteType.Organization)).rejects.toThrow(NotFoundError);
    await expect(cancel(InviteType.Group)).rejects.toThrow(NotFoundError);

    expect(db.invites.update).not.toHaveBeenCalled();
  });

  /**
   * Positive controls. Without these the deny cases above pass trivially - the default mocks return
   * null for everything, so an arm could lose its caller scoping (or be deleted outright) and every
   * deny assertion would still hold. Each case asserts the arm both SUCCEEDS when authorized and
   * passes the acting caller to its predicate, which is what pins the scoping.
   */
  describe('positive controls - each arm authorizes on its own predicate, scoped to the caller', () => {
    it('FabFile: requires the caller own the file', async () => {
      db.fabFiles.findByIdAndUserId = vi.fn(async () => ({ id: DOC_ID }));

      const result = await cancel(InviteType.FabFile);

      expect(db.fabFiles.findByIdAndUserId).toHaveBeenCalledWith(DOC_ID, CALLER_ID);
      expect(result[0].remaining).toBe(0);
    });

    it('Session: requires the caller own the session', async () => {
      db.sessions.findByIdAndUserId = vi.fn(async () => ({ id: DOC_ID }));

      const result = await cancel(InviteType.Session);

      expect(db.sessions.findByIdAndUserId).toHaveBeenCalledWith(DOC_ID, CALLER_ID);
      expect(result[0].remaining).toBe(0);
    });

    it('Organization: requires the caller hold share access on the org', async () => {
      db.organizations.shareable.findShareAccessById = vi.fn(async () => ({ id: DOC_ID }));

      const result = await cancel(InviteType.Organization);

      expect(db.organizations.shareable.findShareAccessById).toHaveBeenCalledWith(asUser(), DOC_ID);
      // The non-admin path must not fall back to the unscoped lookup.
      expect(db.organizations.findById).not.toHaveBeenCalled();
      expect(result[0].remaining).toBe(0);
    });

    it("Group: requires share access on the group's owning organization", async () => {
      db.groups.findById = vi.fn(async () => ({ id: DOC_ID, organizationId: 'org-9' }));
      db.organizations.shareable.findShareAccessById = vi.fn(async () => ({ id: 'org-9' }));

      const result = await cancel(InviteType.Group);

      // Scoped to the group's org, not to the group id the caller supplied.
      expect(db.organizations.shareable.findShareAccessById).toHaveBeenCalledWith(asUser(), 'org-9');
      expect(result[0].remaining).toBe(0);
    });
  });
});
