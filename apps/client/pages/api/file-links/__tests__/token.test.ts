import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findUser: vi.fn(),
  findAccessibleFile: vi.fn(),
  canAccessGenerated: vi.fn(),
  jobOutputExists: vi.fn(),
  signFiles: vi.fn(),
  signGenerated: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { JWT_SECRET: { value: 'test-jwt-secret' } } }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  fabFileRepository: { shareable: { findAccessibleById: h.findAccessibleFile } },
  GenerationJobModel: { exists: h.jobOutputExists },
}));
vi.mock('@bike4mind/server-utils/utils/generatedImageAccess', () => ({
  userCanAccessGeneratedImage: h.canAccessGenerated,
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.signFiles }),
  getGeneratedImageStorage: () => ({ getSignedUrl: h.signGenerated }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = { use: () => chain, get: (handler: unknown) => handler };
  return { baseApi: () => chain };
});

import { signFileLinkToken, type FileLinkTarget } from '@bike4mind/server-utils/files/fileLinkToken';
import handler from '../[token]';

const FILE_ID = 'cccccccccccccccccccccccc';
const owner = { id: 'user-1', groups: [] };
const cleanFile = {
  id: FILE_ID,
  filePath: 'files/user-1/report.pdf',
  fileName: 'report.pdf',
  moderationStatus: 'clean',
  mimeType: 'application/pdf',
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const token = (
  target: FileLinkTarget = { kind: 'fabFile', fileId: FILE_ID },
  over: { exp?: number; userId?: string } = {}
) => signFileLinkToken({ target, userId: over.userId ?? owner.id, exp: over.exp ?? nowSeconds() + 3600 });

const run = async (value: unknown) => {
  const { req, res } = createMocks({ method: 'GET', query: { token: value } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

const expectRefused = (res: Awaited<ReturnType<typeof run>>) => {
  expect(res._getStatusCode()).toBe(404);
  expect(res._getRedirectUrl()).toBeFalsy();
  expect(h.signFiles).not.toHaveBeenCalled();
  expect(h.signGenerated).not.toHaveBeenCalled();
};

beforeAll(() => vi.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z'), toFake: ['Date'] }));
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  h.findUser.mockResolvedValue(owner);
  h.findAccessibleFile.mockResolvedValue(cleanFile);
  h.canAccessGenerated.mockResolvedValue(true);
  h.signFiles.mockResolvedValue('https://files.example.test/signed');
  h.signGenerated.mockResolvedValue('https://generated.example.test/signed');
});

describe('GET /api/file-links/[token]', () => {
  it('redirects the issuing user to a storage URL valid for at most 15 minutes', async () => {
    const res = await run(token());
    expect(res._getStatusCode()).toBe(302);
    expect(res._getRedirectUrl()).toBe('https://files.example.test/signed');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
    expect(h.findAccessibleFile).toHaveBeenCalledWith(owner, FILE_ID);
    const [key, op, opts] = h.signFiles.mock.calls[0];
    expect(key).toBe(cleanFile.filePath);
    expect(op).toBe('get');
    expect(opts.expiresIn).toBeLessThanOrEqual(900);
    expect(opts.ResponseContentDisposition).toContain('attachment; filename="report.pdf"');
  });

  it('refuses when the issuing user can no longer read the file', async () => {
    h.findAccessibleFile.mockResolvedValue(null);
    expectRefused(await run(token(undefined, { userId: 'user-2' })));
  });

  it('refuses an expired token', async () => {
    expectRefused(await run(token(undefined, { exp: nowSeconds() - 1 })));
    expect(h.findUser).not.toHaveBeenCalled();
  });

  it('refuses a tampered token', async () => {
    const [, mac] = token().split('.');
    const forged = Buffer.from(
      JSON.stringify({ t: { kind: 'fabFile', fileId: FILE_ID }, u: 'user-2', e: nowSeconds() + 3600 })
    ).toString('base64url');
    expectRefused(await run(`${forged}.${mac}`));
    expectRefused(await run(`${token()}x`));
    expectRefused(await run(['a', 'b']));
    expect(h.findUser).not.toHaveBeenCalled();
  });

  it.each([{ deletedAt: new Date() }, { moderationStatus: 'blocked' }, { moderationStatus: 'pending' }])(
    'refuses a file that is no longer serveable: %j',
    async change => {
      h.findAccessibleFile.mockResolvedValue({ ...cleanFile, ...change });
      expectRefused(await run(token()));
    }
  );

  it('refuses when the issuing user is gone or blocked', async () => {
    h.findUser.mockResolvedValueOnce(null);
    expectRefused(await run(token()));
    h.findUser.mockResolvedValueOnce({ ...owner, isBanned: true });
    expectRefused(await run(token()));
  });

  it('serves a shared email file under the issuing user prefix', async () => {
    const key = 'shared-email-files/user-1/1700000000000-abcd1234/big.zip';
    const res = await run(token({ kind: 'filesKey', key }));
    expect(res._getStatusCode()).toBe(302);
    expect(h.signFiles).toHaveBeenCalledWith(key, 'get', expect.objectContaining({ expiresIn: 900 }));
  });

  it.each([
    'shared-email-files/user-2/1-a/big.zip',
    'shared-email-files/user-10/1-a/big.zip',
    'files/user-1/report.pdf',
    'shared-email-files/user-1/../user-2/1-a/big.zip',
  ])('refuses a files key outside the issuing user prefix: %s', async key => {
    expectRefused(await run(token({ kind: 'filesKey', key })));
  });

  it('serves a generated output only while the issuing user can access it', async () => {
    const target = { kind: 'generatedKey', key: '9db8f846-08d5-47d7-9166-a039d3c3d4d7.mp4' } as const;
    const res = await run(token(target));
    expect(res._getStatusCode()).toBe(302);
    expect(h.canAccessGenerated).toHaveBeenCalledWith(target.key, owner);
    expect(h.signGenerated).toHaveBeenCalledWith(target.key, 'get', expect.objectContaining({ expiresIn: 900 }));

    vi.clearAllMocks();
    h.findUser.mockResolvedValue(owner);
    h.canAccessGenerated.mockResolvedValue(false);
    h.jobOutputExists.mockResolvedValue(null);
    expectRefused(await run(token(target)));
  });

  it("serves the issuing user's own video job output that no quest references", async () => {
    const target = { kind: 'generatedKey', key: '9db8f846-08d5-47d7-9166-a039d3c3d4d7.mp4' } as const;
    h.canAccessGenerated.mockResolvedValue(false);
    h.jobOutputExists.mockResolvedValue({ _id: 'job-1' });

    const res = await run(token(target));

    expect(res._getStatusCode()).toBe(302);
    expect(h.jobOutputExists).toHaveBeenCalledWith({ requestedBy: owner.id, 'payload.output.s3Key': target.key });
  });
});
