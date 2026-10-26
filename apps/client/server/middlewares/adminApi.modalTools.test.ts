import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import type { AdminTool, IUserDocument } from '@bike4mind/common';

const effects = vi.hoisted(() => ({ list: vi.fn(), tool: vi.fn(), model: vi.fn() }));
vi.mock('./baseApi', () => ({
  baseApi: () => {
    const guards: ((req: Request, res: Response, next: () => void) => unknown)[] = [];
    let endpoint: (req: Request, res: Response) => unknown;
    const chain = async (req: Request, res: Response) => {
      for (const guard of guards) await guard(req, res, () => {});
      return endpoint(req, res);
    };
    chain.use = (guard: (typeof guards)[number]) => {
      guards.push(guard);
      return chain;
    };
    chain.post = (handler: typeof endpoint) => {
      endpoint = handler;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@client/server/tools/modalOperations', () => ({
  createModal: vi.fn(),
  listModals: effects.list,
  updateModal: vi.fn(),
  deleteModal: vi.fn(),
}));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: effects.model },
}));
vi.mock('@client/server/tools/adminToolsServer', async () => {
  const { AdminToolService } = await import('@client/app/services/adminTools/AdminToolService');
  const service = AdminToolService.getInstance();
  service.register({
    name: 'modal',
    command: '/modal',
    description: 'Modal management',
    requiredPermissions: [],
    requiresAdmin: true,
    handler: effects.tool,
  });
  return { initializeServerAdminTools: () => service, getServerAdminToolService: () => service };
});
import directModal from '../../pages/api/admin/modal-tool';
import executeTool from '../../pages/api/admin/tools/execute';
import { AdminToolService } from '../../app/services/adminTools/AdminToolService';

const invoke = async (handler: unknown, adminPermissions: string[], body: object) => {
  const { req, res } = createMocks<Request, Response>({ method: 'POST', body });
  req.user = { id: 'delegated', isAdmin: false, adminPermissions } as Request['user'];
  // Legacy CASL rules intentionally lack the platform-admin grant.
  req.ability = { can: () => false } as Request['ability'];
  await (handler as (req: Request, res: Response) => Promise<unknown>)(req, res);
  return res._getJSONData() as unknown;
};
beforeEach(() => {
  vi.clearAllMocks();
  effects.list.mockResolvedValue({ success: true, data: [] });
  effects.tool.mockResolvedValue({ success: true, data: [] });
  effects.model.mockResolvedValue({
    modelId: 'model',
    llm: {
      complete: async (
        _id: unknown,
        _messages: unknown,
        _options: unknown,
        onChunk: (parts: string[]) => Promise<void>
      ) => onChunk(['{"action":"list","filter":{}}']),
    },
  });
});
describe('delegated modal administration', () => {
  it('direct modal requests execute with settings permission even when CASL has no admin grant', async () => {
    await expect(invoke(directModal, ['settings:manage'], { query: 'List all modals' })).resolves.toEqual({
      success: true,
      data: [],
    });
    expect(effects.list).toHaveBeenCalledOnce();
  });
  it('tool dispatch executes the registered modal service with the real delegated identity', async () => {
    await expect(
      invoke(executeTool, ['settings:manage'], { tool: 'modal', params: { action: 'list' } })
    ).resolves.toEqual({ success: true, data: [] });
    expect(effects.tool).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ isAdmin: false }) }),
      expect.anything()
    );
  });
  it.each([directModal, executeTool])('support cannot reach modal operations', async handler => {
    await expect(
      invoke(handler, ['support:read'], { query: 'List modals', tool: 'modal', params: { action: 'list' } })
    ).rejects.toThrow('Missing permission: settings:manage');
    expect(effects.list).not.toHaveBeenCalled();
    expect(effects.tool).not.toHaveBeenCalled();
    expect(effects.model).not.toHaveBeenCalled();
  });
  it('settings permission does not grant unrelated legacy admin tools', () => {
    const service = AdminToolService.getInstance();
    service.register({
      name: 'unrelated',
      command: '/unrelated',
      description: '',
      requiredPermissions: [],
      requiresAdmin: true,
      handler: effects.tool,
    } satisfies AdminTool);
    expect(
      service.canAccess({ isAdmin: false, adminPermissions: ['settings:manage'] } as IUserDocument, 'unrelated')
    ).toBe(false);
    expect(service.canAccess({ isAdmin: true } as IUserDocument, 'unrelated')).toBe(true);
  });
});
