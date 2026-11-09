// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { Permission } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

const { findShareAccessById, reserveBudget, createInvite } = vi.hoisted(() => ({
  findShareAccessById: vi.fn(),
  reserveBudget: vi.fn(),
  createInvite: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  projectRepository: { shareable: { findShareAccessById } },
  activityRepository: {},
  fabFileRepository: {},
  inviteRepository: {},
  organizationRepository: {},
  sessionRepository: {},
  userRepository: {},
  Group: {},
  Project: { findById: vi.fn().mockResolvedValue(null) },
  withTransaction: async (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('@bike4mind/services', () => ({ projectService: {}, sharingService: { createInvite } }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/createDocumentInvite', () => ({ generateInviteLink: vi.fn() }));
vi.mock('@server/managers/inviteManager', () => ({ toSharerInviteViews: vi.fn() }));
vi.mock('@server/sharing/revokedFileReferences', () => ({
  cleanUpRevokedFileReferences: vi.fn(),
  projectRevokeCleanupTargets: vi.fn(),
}));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({ getInviteTypeName: vi.fn() }));
vi.mock('@server/utils/inviteSendLimits', () => ({
  notifyInvitees: vi.fn(),
  reserveInviteSendBudget: reserveBudget,
}));

import { toSharerInviteViews } from '@server/managers/inviteManager';
import { Project } from '@bike4mind/database';
import { createProjectInvite } from './projectSharingMutations';

const user = { id: 'caller', groups: [] } as unknown as IUserDocument;
const projectId = '65a000000000000000000001';
const input = { permissions: [Permission.read], recipients: ['teammate@example.com'] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('createProjectInvite project access', () => {
  it('reports malformed project ids as 404 before looking up a project or reserving mail', async () => {
    await expect(createProjectInvite({ user }, 'not-an-id', input)).rejects.toThrow(NotFoundError);
    expect(findShareAccessById).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('reports an absent share-access result as 404 before reserving mail', async () => {
    findShareAccessById.mockResolvedValue(null);

    await expect(createProjectInvite({ user }, projectId, input)).rejects.toThrow(NotFoundError);

    expect(findShareAccessById).toHaveBeenCalledExactlyOnceWith(user, projectId);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('propagates failed access reads before reserving mail', async () => {
    const failure = new Error('Project lookup unavailable');
    findShareAccessById.mockRejectedValue(failure);

    await expect(createProjectInvite({ user }, projectId, input)).rejects.toBe(failure);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(createInvite).not.toHaveBeenCalled();
  });
});

describe('createProjectInvite resolved project id', () => {
  it('persists the canonical project id for an uppercase request', async () => {
    findShareAccessById.mockResolvedValue({ id: projectId });
    reserveBudget.mockResolvedValue({ release: vi.fn() });
    createInvite.mockResolvedValue({ id: 'invite-1', recipients: { pending: [] } });
    vi.mocked(Project.findById).mockResolvedValue(null);
    vi.mocked(toSharerInviteViews).mockResolvedValue([{}]);

    await createProjectInvite({ user }, projectId.toUpperCase(), input);

    expect(findShareAccessById).toHaveBeenCalledWith(user, projectId.toUpperCase());
    expect(createInvite).toHaveBeenCalledWith(user, expect.objectContaining({ id: projectId }), expect.anything());
  });
});
