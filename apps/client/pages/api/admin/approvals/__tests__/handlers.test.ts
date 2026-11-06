// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  options: [] as unknown[],
  handlers: {} as Record<string, (req: Request, res: Response) => Promise<unknown>>,
  current: '',
  approve: vi.fn(),
  reject: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    mocks.options.push(options);
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    for (const method of ['get', 'post']) {
      chain[method] = (fn: (req: Request, res: Response) => Promise<unknown>) => {
        mocks.handlers[mocks.current] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/auth/stepUp', () => ({ stepUpGate: () => vi.fn() }));
vi.mock('@server/admin/approvals/service', () => ({
  APPROVAL_LIST_MAX: 100,
  approveApproval: mocks.approve,
  rejectApproval: mocks.reject,
  listApprovals: mocks.list,
}));

const load = async (name: string, importer: () => Promise<unknown>) => {
  mocks.current = name;
  await importer();
  return mocks.handlers[name]!;
};

const resMock = () => {
  const res = { json: vi.fn() };
  return res as unknown as Response & { json: ReturnType<typeof vi.fn> };
};
const reqOf = (fields: Record<string, unknown>) => ({ user: { id: 'b' }, ...fields }) as unknown as Request;

describe('approval routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('are JWT-only so an API key never decides an approval', async () => {
    await load('index', () => import('../index'));
    await load('approve', () => import('../[id]/approve'));
    await load('reject', () => import('../[id]/reject'));
    expect(mocks.options).toHaveLength(3);
    for (const options of mocks.options) expect(options).toMatchObject({ auth: 'jwtOnly' });
  });

  it('list defaults to pending and passes all as no status filter', async () => {
    const list = await load('index', () => import('../index'));
    mocks.list.mockResolvedValue([]);
    await list(reqOf({ query: {} }), resMock());
    expect(mocks.list).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'pending' }));
    await list(reqOf({ query: { status: 'all' } }), resMock());
    expect(mocks.list).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: undefined }));
    await expect(list(reqOf({ query: { status: 'bogus' } }), resMock())).rejects.toMatchObject({ statusCode: 400 });
  });

  it('approve passes the path id to the service', async () => {
    const approve = await load('approve', () => import('../[id]/approve'));
    mocks.approve.mockResolvedValue({ approval: { id: 'x' }, result: { updated: 1 } });
    const res = resMock();
    await approve(reqOf({ query: { id: 'x' } }), res);
    expect(mocks.approve).toHaveBeenCalledWith(expect.anything(), 'x');
    expect(res.json).toHaveBeenCalledWith({ approval: { id: 'x' }, result: { updated: 1 } });
  });

  it('reject needs a reason before reaching the service', async () => {
    const reject = await load('reject', () => import('../[id]/reject'));
    await expect(reject(reqOf({ query: { id: 'x' }, body: { reason: '' } }), resMock())).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(reject(reqOf({ query: { id: 'x' }, body: {} }), resMock())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mocks.reject).not.toHaveBeenCalled();
    mocks.reject.mockResolvedValue({ id: 'x', status: 'rejected' });
    await reject(reqOf({ query: { id: 'x' }, body: { reason: 'Not justified by the ticket' } }), resMock());
    expect(mocks.reject).toHaveBeenCalledWith(expect.anything(), 'x', 'Not justified by the ticket');
  });
});
