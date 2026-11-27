// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { Permission } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

const { findShareAccessById, reserveBudget, createInvite, leaveProject, createActivity, rescope } = vi.hoisted(() => ({
  findShareAccessById: vi.fn(),
  reserveBudget: vi.fn(),
  createInvite: vi.fn(),
  leaveProject: vi.fn(),
  createActivity: vi.fn(),
  rescope: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  spaceRepository: {},
  adminSettingsRepository: {},
  projectRepository: { shareable: { findShareAccessById } },
  activityRepository: { createActivity },
  fabFileRepository: {},
  inviteRepository: {},
  organizationRepository: {},
  sessionRepository: {},
  userRepository: {},
  Group: {},
  Project: { findById: vi.fn().mockResolvedValue(null) },
  withTransaction: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));
vi.mock('@bike4mind/services', () => ({ projectService: { leaveProject }, sharingService: { createInvite } }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/createDocumentInvite', () => ({ generateInviteLink: vi.fn() }));
vi.mock('@server/managers/inviteManager', () => ({ toSharerInviteViews: vi.fn() }));
vi.mock('@server/sharing/revokedFileReferences', () => ({
  cleanUpRevokedFileReferences: vi.fn(),
  projectRevokeCleanupTargets: vi.fn(),
}));
vi.mock('@server/websocket/rescopeUserSubscriptions', () => ({ rescopeUserSubscriptions: rescope }));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({ getInviteTypeName: vi.fn() }));
vi.mock('@server/utils/inviteSendLimits', () => ({
  notifyInvitees: vi.fn(),
  reserveInviteSendBudget: reserveBudget,
}));

import { toSharerInviteViews } from '@server/managers/inviteManager';
import { Project, withTransaction } from '@bike4mind/database';
import { cleanUpRevokedFileReferences, projectRevokeCleanupTargets } from '@server/sharing/revokedFileReferences';
import { createProjectInvite, removeProjectMember } from './projectSharingMutations';

const user = { id: 'caller', groups: [] } as unknown as IUserDocument;
const projectId = '65a000000000000000000001';
const input = { permissions: [Permission.read], recipients: ['teammate@example.com'] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(withTransaction).mockImplementation(async operation => operation());
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

describe('removeProjectMember subscription rescoping', () => {
  const logger = { warn: vi.fn() } as never;
  const targets = [
    { userId: 'owner', fileIds: ['f1'] },
    { userId: 'member-1', fileIds: [] },
  ];

  beforeEach(() => {
    vi.mocked(projectRevokeCleanupTargets).mockResolvedValue(targets);
    leaveProject.mockImplementation(
      async (
        _user: unknown,
        _params: unknown,
        adapters: {
          onAccessRemoved: (ids: string[]) => void;
        }
      ) => {
        adapters.onAccessRemoved(['actual-recipient', 'actual-descendant']);
        return { id: projectId, name: 'project' };
      }
    );
  });

  it('fences actual mutation recipients before optional reference cleanup', async () => {
    await removeProjectMember({ user, logger }, projectId, 'member-1');

    expect(projectRevokeCleanupTargets).toHaveBeenCalledWith(projectId, 'member-1', logger);
    expect(rescope).toHaveBeenCalledExactlyOnceWith(['actual-recipient', 'actual-descendant'], logger);
    expect(leaveProject.mock.invocationCallOrder[0]).toBeLessThan(rescope.mock.invocationCallOrder[0]);
    expect(rescope.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(cleanUpRevokedFileReferences).mock.invocationCallOrder[0]
    );
  });

  it('rescopes actual recipients when the caller leaves', async () => {
    await removeProjectMember({ user, logger }, projectId);

    expect(projectRevokeCleanupTargets).toHaveBeenCalledWith(projectId, user.id, logger);
    expect(rescope).toHaveBeenCalledExactlyOnceWith(['actual-recipient', 'actual-descendant'], logger);
  });

  it('still fences actual recipients when the optional planner returns no targets', async () => {
    vi.mocked(projectRevokeCleanupTargets).mockResolvedValue([]);
    await removeProjectMember({ user, logger }, projectId, 'member-1');
    expect(rescope).toHaveBeenCalledExactlyOnceWith(['actual-recipient', 'actual-descendant'], logger);
  });

  it('publishes only the committed attempt after a transaction retry', async () => {
    leaveProject.mockImplementationOnce(
      async (
        _user: unknown,
        _params: unknown,
        adapters: {
          onAccessRemoved: (ids: string[]) => void;
        }
      ) => {
        adapters.onAccessRemoved(['aborted-recipient']);
        return { id: projectId, name: 'project' };
      }
    );
    vi.mocked(withTransaction).mockImplementationOnce(async operation => {
      await operation();
      expect(rescope).not.toHaveBeenCalled();
      return operation();
    });
    await removeProjectMember({ user, logger }, projectId, 'member-1');
    expect(rescope).toHaveBeenCalledExactlyOnceWith(['actual-recipient', 'actual-descendant'], logger);
  });

  it('does not rescope when the leave fails', async () => {
    leaveProject.mockRejectedValue(new Error('boom'));

    await expect(removeProjectMember({ user, logger }, projectId, 'member-1')).rejects.toThrow('boom');
    expect(rescope).not.toHaveBeenCalled();
  });
});
