import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
interface BaseApiChain {
  delete: (fn: Handler) => BaseApiChain;
}

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | Handler,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: BaseApiChain = {
    delete: fn => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const leaveProject = vi.hoisted(() => vi.fn());
vi.mock('@server/projects/projectScopes', () => ({ PROJECTS_WRITE_SCOPES: [] }));

vi.mock('@bike4mind/services', () => ({
  projectService: { leaveProject: (...a: unknown[]) => leaveProject(...a) },
}));

const createActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/database', () => ({
  projectRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: {},
  activityRepository: { createActivity },
  withTransaction: (fn: () => unknown) => fn(),
}));

const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  ProjectEvents: { REMOVE_MEMBER: 'remove_member', PROJECT_LEAVED: 'project_leaved' },
}));

const refCleanup = vi.hoisted(() => ({
  targets: vi.fn().mockResolvedValue([{ userId: 'planned', fileIds: ['f1'] }]),
  cleanUp: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/sharing/revokedFileReferences', () => ({
  projectRevokeCleanupTargets: (...a: unknown[]) => refCleanup.targets(...a),
  cleanUpRevokedFileReferences: (...a: unknown[]) => refCleanup.cleanUp(...a),
}));

import '@pages/api/projects/[id]/members';

function request(body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'p1' }, body });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  (req as unknown as { ability: Record<string, unknown> }).ability = {};
  (req as unknown as { logger: Record<string, unknown> }).logger = { warn: vi.fn() };
  return { req, res };
}

describe('DELETE /api/projects/[id]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs PROJECT_LEAVED and records an activity when a member leaves voluntarily', async () => {
    leaveProject.mockResolvedValue({ id: 'p1', name: 'Project' });
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'project_leaved' }), expect.anything());
    expect(createActivity).toHaveBeenCalled();
  });

  it('logs REMOVE_MEMBER and skips the activity record when an owner removes a member', async () => {
    leaveProject.mockResolvedValue({ id: 'p1', name: 'Project' });
    const { req, res } = request({ userId: 'member-1' });

    await mockRefs.deleteHandler!(req, res);

    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'remove_member' }), expect.anything());
    expect(createActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['a member leaving', {}, 'u1'],
    ['an owner removing a member', { userId: 'member-1' }, 'member-1'],
    // leaveProject treats an empty userId as a self-leave; planning must too, not as a project delete.
    ['a member leaving with an empty userId', { userId: '' }, 'u1'],
  ])('plans the reference cleanup before %s and runs it after the commit', async (_label, body, revoked) => {
    leaveProject.mockResolvedValue({ id: 'p1', name: 'Project' });
    const { req, res } = request(body);

    await mockRefs.deleteHandler!(req, res);

    expect(refCleanup.targets).toHaveBeenCalledWith('p1', revoked, expect.anything());
    expect(refCleanup.cleanUp).toHaveBeenCalledWith([{ userId: 'planned', fileIds: ['f1'] }], expect.anything());
    expect(refCleanup.targets.mock.invocationCallOrder[0]).toBeLessThan(leaveProject.mock.invocationCallOrder[0]);
    expect(leaveProject.mock.invocationCallOrder[0]).toBeLessThan(refCleanup.cleanUp.mock.invocationCallOrder[0]);
  });

  it('does not clean up when the leave fails', async () => {
    leaveProject.mockRejectedValue(new Error('denied'));
    const { req, res } = request();

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('denied');
    expect(refCleanup.cleanUp).not.toHaveBeenCalled();
  });
});
