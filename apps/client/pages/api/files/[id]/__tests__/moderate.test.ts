import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  updateOne: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  scan: vi.fn(),
  writeVerdict: vi.fn(),
  getMetadata: vi.fn(),
  reconcile: vi.fn(),
  sendToClient: vi.fn(),
  sleep: vi.fn(),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { post: (handler: unknown) => handler };
  },
}));
vi.mock('node:timers/promises', () => ({ setTimeout: h.sleep }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@bike4mind/database', () => ({ FabFile: { findById: h.findById, updateOne: h.updateOne } }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getMetadata: h.getMetadata }) }));
vi.mock('@server/s3/moderationScan', () => ({
  claimModerationScan: h.claim,
  recordLandedObject: h.reconcile,
  normalizeETag: (eTag?: string) => eTag?.replace(/^"|"$/g, '') || undefined,
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
    h.getMetadata.mockResolvedValue({ etag: '"etag-a"' });
    h.reconcile.mockReset();
    h.reconcile.mockResolvedValue(undefined);
    h.release.mockResolvedValue(undefined);
    h.updateOne.mockResolvedValue(undefined);
    h.sendToClient.mockResolvedValue(undefined);
    h.sleep.mockResolvedValue(undefined);
  });

  it('returns pending without claiming or scanning once the attempt cap is reached', async () => {
    h.findById.mockResolvedValue(file({ moderationAttempts: 4 }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body).toEqual({ moderationStatus: 'pending' });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
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

  it('reconciles the current version before claiming without rewriting its ETag', async () => {
    await handler(makeReq(), makeRes());
    expect(h.reconcile).toHaveBeenCalledWith('oid1', 'masks/m.png');
    expect(h.claim).toHaveBeenCalledWith('oid1', expect.any(Date));
    expect(h.reconcile.mock.invocationCallOrder[0]).toBeLessThan(h.claim.mock.invocationCallOrder[0]);
  });

  it('logs and leaves the file pending when its current version cannot be reconciled', async () => {
    h.reconcile.mockRejectedValueOnce(new Error('head failed'));
    const res = makeRes();
    const req = makeReq();
    await handler(req, res);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.writeVerdict).not.toHaveBeenCalled();
    expect(req.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not reconcile'), expect.anything());
    expect(res.body).toEqual({ moderationStatus: 'pending' });
  });

  it('scans the file row itself, so a marked upload reaches the constraint in scanUploadedObject', async () => {
    const marked = file({ sourceMetadata: { uploadedVia: 'ai-generate-key-upload' } });
    h.findById.mockResolvedValue(marked);
    await handler(makeReq(), makeRes());
    expect(h.scan).toHaveBeenCalledWith(expect.objectContaining({ fabFile: marked }));
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

  it('waits for the owner verdict when another invocation holds the claim, without scanning', async () => {
    h.claim.mockResolvedValue(null);
    h.findById
      .mockResolvedValueOnce(file())
      .mockResolvedValueOnce(file({ moderationStatus: 'scanning' }))
      .mockResolvedValueOnce(file({ moderationStatus: 'clean' }));
    const res = makeRes();
    const req = makeReq();
    await handler(req, res);

    expect(h.scan).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(2);
    expect(res.body).toEqual({ moderationStatus: 'clean' });
    expect(req.logger.warn).not.toHaveBeenCalled();
  });

  it('relays a blocked owner verdict', async () => {
    h.claim.mockResolvedValue(null);
    h.findById.mockResolvedValueOnce(file()).mockResolvedValueOnce(file({ moderationStatus: 'blocked' }));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.body).toEqual({ moderationStatus: 'blocked' });
  });

  it('reports pending and logs it when the owner verdict never lands within the wait', async () => {
    h.claim.mockResolvedValue(null);
    const res = makeRes();
    const req = makeReq();
    await handler(req, res);

    expect(h.scan).not.toHaveBeenCalled();
    expect(h.sleep).toHaveBeenCalledTimes(10);
    expect(req.logger.warn).toHaveBeenCalledWith('On-demand moderation left the file pending', {
      fabFileId: 'ff1',
      reason: 'claim lost',
    });
    expect(res.body).toEqual({ moderationStatus: 'pending' });
  });

  it('waits for the successor verdict when its own verdict write was superseded', async () => {
    h.writeVerdict.mockResolvedValue(false);
    h.findById.mockResolvedValueOnce(file()).mockResolvedValueOnce(file({ moderationStatus: 'clean' }));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.sendToClient).not.toHaveBeenCalled();
    expect(res.body).toEqual({ moderationStatus: 'clean' });
  });

  it('waits for the owner verdict when the S3 event takes the claim during the retry backoff', async () => {
    h.scan.mockRejectedValueOnce(new Error('Rekognition throttled'));
    h.claim.mockResolvedValueOnce({ id: 'ff1' }).mockResolvedValueOnce(null);
    h.findById.mockResolvedValueOnce(file()).mockResolvedValueOnce(file({ moderationStatus: 'clean' }));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ moderationStatus: 'clean' });
  });

  it('releases the claim across the backoff and lands the retry under a fresh claim', async () => {
    h.scan.mockRejectedValueOnce(new Error('Rekognition throttled'));
    const res = makeRes();
    await handler(makeReq(), res);

    const [firstStamp, retryStamp] = h.claim.mock.calls.map(([, claimedAt]) => claimedAt);
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('oid1', firstStamp);
    expect(h.release.mock.invocationCallOrder[0]).toBeLessThan(h.sleep.mock.invocationCallOrder[0]);
    expect(h.sleep.mock.invocationCallOrder[0]).toBeLessThan(h.claim.mock.invocationCallOrder[1]);
    expect(h.writeVerdict).toHaveBeenCalledWith('oid1', retryStamp, { moderationStatus: 'clean' });
    expect(res.body).toEqual({ moderationStatus: 'clean' });
  });

  it('reports pending without a second scan when the S3 event takes the claim during the backoff', async () => {
    h.scan.mockRejectedValueOnce(new Error('Rekognition throttled'));
    h.claim.mockResolvedValueOnce({ id: 'ff1' }).mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(makeReq(), res);

    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.writeVerdict).not.toHaveBeenCalled();
    expect(res.body).toEqual({ moderationStatus: 'pending' });
  });

  it('hands the claim back and reports pending, never blocked, when the retry also fails', async () => {
    h.scan.mockRejectedValue(new Error('Rekognition throttled'));
    const res = makeRes();
    await handler(makeReq(), res);

    const retryStamp = h.claim.mock.calls[1][1];
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(h.writeVerdict).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenLastCalledWith('oid1', retryStamp);
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
