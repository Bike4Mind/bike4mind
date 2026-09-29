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
vi.mock('@bike4mind/common', () => ({
  ProjectEvents: { REMOVE_MEMBER: 'remove_member', PROJECT_LEAVED: 'project_leaved' },
}));
vi.mock('@client/config/activities', () => ({ ActivityType: { PROJECT_LEAVED: 'project_leaved' } }));

import '@pages/api/projects/[id]/members';

function request(body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'p1' }, body });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  (req as unknown as { ability: Record<string, unknown> }).ability = {};
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
});
