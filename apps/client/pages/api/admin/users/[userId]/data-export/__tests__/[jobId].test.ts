import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  get: undefined as undefined | ((req: unknown, res: unknown) => Promise<unknown>),
  adminApiOptions: undefined as unknown,
  calls: [] as string[],
  record: vi.fn(),
  requireStepUp: vi.fn(),
  findTarget: vi.fn(),
  builtAt: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.adminApiOptions = options;
    return {
      get: (fn: typeof h.get) => {
        h.get = fn;
      },
    };
  },
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: h.requireStepUp }));
vi.mock('@server/dataSubject/adminDataExports', () => ({
  findDataExportTarget: h.findTarget,
  readAdminDataExportBuiltAt: h.builtAt,
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.record }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({ getSignedUrl: h.sign }) }));

import { ApiKeyScope } from '@bike4mind/common';
import '../[jobId]';

const USER_ID = '665f1c2e8b3a4d0012345678';
const JOB_ID = '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
const TARGET = { kind: 'user', id: USER_ID, displayName: 'ada@example.com' };

async function run(jobId = JOB_ID) {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, jobId } });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
  await h.get!(req, res);
  return res;
}

beforeEach(() => {
  h.calls = [];
  h.requireStepUp.mockReset().mockResolvedValue(undefined);
  h.findTarget.mockReset().mockResolvedValue({ user: { id: USER_ID }, auditTarget: TARGET });
  h.builtAt.mockReset().mockResolvedValue(new Date(Date.now() - 60_000));
  h.record.mockReset().mockImplementation(async () => void h.calls.push('audit'));
  h.sign.mockReset().mockImplementation(async () => {
    h.calls.push('sign');
    return 'https://signed.example/export.zip';
  });
});

describe('admin data subject export download', () => {
  it('needs users:export and admin-scoped keys', () => {
    expect(h.adminApiOptions).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'users:export' },
    });
  });

  it('audits the download before signing a five-minute link to the admin export key', async () => {
    const res = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(h.calls).toEqual(['audit', 'sign']);
    expect(h.record).toHaveBeenCalledWith(expect.anything(), {
      action: 'user.data_export.downloaded',
      target: TARGET,
      summary: 'downloaded a data subject export',
      details: { exportJobId: JOB_ID },
    });
    expect(h.sign).toHaveBeenCalledWith(
      `exports/account-data/${USER_ID}/admin/${JOB_ID}/data-subject-export.zip`,
      'get',
      expect.objectContaining({ audience: 'browser', expiresIn: 300 })
    );
    expect(res._getJSONData()).toMatchObject({ url: 'https://signed.example/export.zip' });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });

  it('signs nothing when the download cannot be audited', async () => {
    h.record.mockRejectedValue(new Error('audit write failed'));

    await expect(run()).rejects.toThrow('audit write failed');
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('signs nothing without a fresh step-up', async () => {
    h.requireStepUp.mockRejectedValue(new Error('step_up_required'));

    await expect(run()).rejects.toThrow('step_up_required');
    expect(h.findTarget).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('rejects a malformed id, a missing export and an expired one without auditing', async () => {
    expect((await run('not-a-uuid'))._getStatusCode()).toBe(400);

    h.builtAt.mockResolvedValue(null);
    expect((await run())._getStatusCode()).toBe(404);

    h.builtAt.mockResolvedValue(new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect((await run())._getStatusCode()).toBe(410);

    expect(h.record).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });
});
