import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  updateOne: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  scan: vi.fn(),
  writeVerdict: vi.fn(),
  sendToClient: vi.fn(),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { post: (handler: unknown) => handler };
  },
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@bike4mind/database', () => ({ FabFile: { findById: h.findById, updateOne: h.updateOne } }));
vi.mock('@server/s3/moderationScan', () => ({
  claimModerationScan: h.claim,
  releaseModerationClaim: h.release,
  scanUploadedObject: h.scan,
  writeModerationVerdict: h.writeVerdict,
  toVerdictPatch: (r: { moderationStatus: string; blockReason?: string }) => ({
    moderationStatus: r.moderationStatus,
    ...(r.blockReason ? { blockReason: r.blockReason } : {}),
  }),
}));

const handler = (await import('../moderate')).default as (req: Request, res: Response) => Promise<unknown>;

const makeRes = () => {
  const res = {} as Response & { statusCode: number; body: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
};

const makeReq = (userId = 'u1') =>
  ({
    query: { id: 'ff1' },
    user: { id: userId },
    logger: { warn: vi.fn() },
  }) as unknown as Request;

const file = (over: Record<string, unknown> = {}) => ({
  _id: 'oid1',
  id: 'ff1',
  userId: 'u1',
  filePath: 'masks/m.png',
  mimeType: 'image/png',
  moderationStatus: 'pending',
  ...over,
});

describe('POST /api/files/[id]/moderate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue(file());
    h.claim.mockResolvedValue({ id: 'ff1' });
    h.scan.mockResolvedValue({ moderationStatus: 'clean' });
    h.writeVerdict.mockResolvedValue(true);
    h.release.mockResolvedValue(undefined);
    h.updateOne.mockResolvedValue(undefined);
    h.sendToClient.mockResolvedValue(undefined);
  });

  it('requires a files write scope so unscoped API keys cannot drive scans', () => {
    expect(h.baseApiOptions).toMatchObject({ requiredScopes: expect.any(Array) });
  });

  it('404s a missing file and a file owned by someone else, without scanning', async () => {
    h.findById.mockResolvedValueOnce(null);
    const missing = makeRes();
    await handler(makeReq(), missing);
    expect(missing.status).toHaveBeenCalledWith(404);

    h.findById.mockResolvedValueOnce(file({ userId: 'someone-else' }));
    const foreign = makeRes();
    await handler(makeReq('u1'), foreign);
    expect(foreign.status).toHaveBeenCalledWith(404);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
  });

  it('scans a pending file under the claim and reports the verdict', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.writeVerdict).toHaveBeenCalledWith('oid1', expect.any(Date), { moderationStatus: 'clean' });
    expect(res.body).toEqual({ moderationStatus: 'clean' });
  });

  it('reports a blocked verdict with its reason', async () => {
    h.scan.mockResolvedValue({ moderationStatus: 'blocked', blockReason: 'unsupported_format' });
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.writeVerdict).toHaveBeenCalledWith('oid1', expect.any(Date), {
      moderationStatus: 'blocked',
      blockReason: 'unsupported_format',
    });
    expect(res.body).toEqual({ moderationStatus: 'blocked' });
  });

  it('400s a file with no storage path without claiming or scanning it', async () => {
    h.findById.mockResolvedValue(file({ filePath: undefined }));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
  });

  it.each(['clean', 'blocked'])('does not re-scan a file that already has a %s verdict', async status => {
    h.findById.mockResolvedValue(file({ moderationStatus: status }));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.claim).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
    expect(res.body).toEqual({ moderationStatus: status });
  });

  it('reports pending without scanning when another invocation owns the claim', async () => {
    h.claim.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.scan).not.toHaveBeenCalled();
    expect(res.body).toEqual({ moderationStatus: 'pending' });
  });

  it('hands the claim back and reports pending, never blocked, on a transient scan failure', async () => {
    h.scan.mockRejectedValue(new Error('Rekognition throttled'));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.writeVerdict).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith('oid1', expect.any(Date));
    expect(res.body).toEqual({ moderationStatus: 'pending' });
  });

  it('reports pending when the claim was superseded before the verdict landed', async () => {
    h.writeVerdict.mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.sendToClient).not.toHaveBeenCalled();
    expect(res.body).toEqual({ moderationStatus: 'pending' });
  });

  it('persists the byte-sniffed mime type in the same guarded write as the verdict', async () => {
    h.scan.mockResolvedValue({ moderationStatus: 'clean', correctedMimeType: 'image/jpeg' });
    await handler(makeReq(), makeRes());

    expect(h.writeVerdict).toHaveBeenCalledWith('oid1', expect.any(Date), {
      moderationStatus: 'clean',
      mimeType: 'image/jpeg',
    });
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('leaves the stored mime type alone when the scan confirms it', async () => {
    h.scan.mockResolvedValue({ moderationStatus: 'clean', correctedMimeType: 'image/png' });
    await handler(makeReq(), makeRes());

    expect(h.writeVerdict).toHaveBeenCalledWith('oid1', expect.any(Date), { moderationStatus: 'clean' });
  });

  it('tells the owner the final verdict over the websocket', async () => {
    await handler(makeReq(), makeRes());

    expect(h.sendToClient).toHaveBeenCalledWith('u1', 'wss://test', {
      action: 'image_moderation_status',
      fabFileId: 'ff1',
      moderationStatus: 'clean',
    });
  });

  it('still returns the verdict when the websocket send fails', async () => {
    h.sendToClient.mockRejectedValue(new Error('gone'));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.release).not.toHaveBeenCalled();
    expect(res.body).toEqual({ moderationStatus: 'clean' });
  });
});
