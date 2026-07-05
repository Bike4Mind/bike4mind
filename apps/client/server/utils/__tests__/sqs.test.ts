// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class MockSQSClient {
    send(...args: unknown[]) {
      return mockSend(...args);
    }
  },
  SendMessageBatchCommand: class {
    constructor(public input: unknown) {}
  },
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
  ReceiveMessageCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteMessageCommand: class {
    constructor(public input: unknown) {}
  },
  GetQueueAttributesCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { sendBatchToQueue } from '../sqs';

function allSuccess(entries: { Id: string }[]) {
  return {
    Successful: entries.map(e => ({ Id: e.Id, MessageId: `msg-${e.Id}` })),
    Failed: [],
  };
}

function withFailures(entries: { Id: string }[], failIds: { Id: string; SenderFault: boolean }[]) {
  const failSet = new Set(failIds.map(f => f.Id));
  return {
    Successful: entries.filter(e => !failSet.has(e.Id)).map(e => ({ Id: e.Id, MessageId: `msg-${e.Id}` })),
    Failed: failIds.map(f => ({ Id: f.Id, SenderFault: f.SenderFault, Code: 'Err', Message: 'fail' })),
  };
}

const QUEUE = 'https://sqs.us-east-2.amazonaws.com/123/test-queue';

describe('sendBatchToQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5 messages all succeed — returns success with correct original indices', async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ payload: i }));
    mockSend.mockResolvedValue(allSuccess([{ Id: '0-0' }, { Id: '0-1' }, { Id: '0-2' }, { Id: '0-3' }, { Id: '0-4' }]));
    const results = await sendBatchToQueue(QUEUE, msgs);
    expect(results).toHaveLength(5);
    expect(results.every(r => r.success)).toBe(true);
    expect(results.map(r => r.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('transient failure (SenderFault:false) is retried once; success on retry', async () => {
    mockSend
      .mockResolvedValueOnce(
        withFailures([{ Id: '0-0' }, { Id: '0-1' }, { Id: '0-2' }], [{ Id: '0-1', SenderFault: false }])
      )
      .mockResolvedValueOnce({ Successful: [{ Id: '0-1', MessageId: 'msg-retry' }], Failed: [] });

    const msgs = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const results = await sendBatchToQueue(QUEUE, msgs);
    expect(results).toHaveLength(3);
    const retried = results.find(r => r.index === 1);
    expect(retried?.success).toBe(true);
    expect(retried?.messageId).toBe('msg-retry');
  });

  it('permanent failure (SenderFault:true) is not retried — surfaces as failure', async () => {
    mockSend.mockResolvedValueOnce(
      withFailures([{ Id: '0-0' }, { Id: '0-1' }, { Id: '0-2' }], [{ Id: '0-1', SenderFault: true }])
    );

    const msgs = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const results = await sendBatchToQueue(QUEUE, msgs);
    expect(mockSend).toHaveBeenCalledTimes(1); // no retry
    const failed = results.find(r => r.index === 1);
    expect(failed?.success).toBe(false);
  });

  it('25 messages → 3 chunks (10+10+5); failures at indices 3, 12, 22 map to correct positions', async () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ i }));

    // chunk 0: fail index 3 -> Id '0-3'
    mockSend
      .mockResolvedValueOnce(
        withFailures(
          Array.from({ length: 10 }, (_, i) => ({ Id: `0-${i}` })),
          [{ Id: '0-3', SenderFault: true }]
        )
      )
      // chunk 1: fail index 2 (caller index 12) -> Id '1-2'
      .mockResolvedValueOnce(
        withFailures(
          Array.from({ length: 10 }, (_, i) => ({ Id: `1-${i}` })),
          [{ Id: '1-2', SenderFault: true }]
        )
      )
      // chunk 2: fail index 2 (caller index 22) -> Id '2-2'
      .mockResolvedValueOnce(
        withFailures(
          Array.from({ length: 5 }, (_, i) => ({ Id: `2-${i}` })),
          [{ Id: '2-2', SenderFault: true }]
        )
      );

    const results = await sendBatchToQueue(QUEUE, msgs);
    const failedIndices = results
      .filter(r => !r.success)
      .map(r => r.index)
      .sort((a, b) => a - b);
    expect(failedIndices).toEqual([3, 12, 22]);
    expect(results).toHaveLength(25);
  });

  it('empty array returns empty results', async () => {
    const results = await sendBatchToQueue(QUEUE, []);
    expect(results).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
