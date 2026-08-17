import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getFabFileById: vi.fn(),
  sendToQueue: vi.fn(),
  sendToClient: vi.fn(),
  getSourceQueueUrl: vi.fn(),
}));

// Single-method chain: the route only calls `.post(...)`.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));

vi.mock('@server/managers/fabFileManager', () => ({ getFabFileById: h.getFabFileById }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));

import handler from '../chunk';

const FILE = { _id: 'f1', id: 'f1', userId: 'u1', isChunking: false };

const makeRes = () => {
  const json = vi.fn();
  return { res: { json } as never, json };
};

const req = (body: unknown) =>
  ({
    method: 'POST',
    user: { id: 'u1' },
    ability: { can: () => true },
    body,
  }) as never;

const run = (body: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(body), res);

describe('POST /api/files/chunk - chunkSize ceiling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getFabFileById.mockResolvedValue(FILE);
    h.getSourceQueueUrl.mockReturnValue('http://sqs/chunk');
    h.sendToQueue.mockResolvedValue('msg-1');
    h.sendToClient.mockResolvedValue(undefined);
  });

  it('rejects a chunkSize above the detection threshold', async () => {
    const { res } = makeRes();
    await expect(run({ fabFileId: 'f1', chunkSize: '1501' }, res)).rejects.toThrow(/must not exceed 1500/i);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('accepts a chunkSize exactly at the detection threshold (detection is $gt)', async () => {
    const { res, json } = makeRes();
    await run({ fabFileId: 'f1', chunkSize: '1500' }, res);
    expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/chunk', expect.objectContaining({ chunkSize: '1500' }));
    expect(json).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });

  it('accepts a typical chunkSize', async () => {
    const { res, json } = makeRes();
    await run({ fabFileId: 'f1', chunkSize: '300' }, res);
    expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/chunk', expect.objectContaining({ chunkSize: '300' }));
    expect(json).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });
});
