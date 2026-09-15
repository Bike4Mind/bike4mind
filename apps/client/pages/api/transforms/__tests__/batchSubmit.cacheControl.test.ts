import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

/**
 * The cache breakpoint fails silently in the one direction that matters.
 *
 * Zod strips unknown keys rather than rejecting them, so a schema that does
 * not name `cache_control` still returns 202 - the breakpoint just quietly
 * disappears, every request writes at 1.25x instead of reading at 0.1x, and
 * the only place it shows up is the Anthropic bill. These pin that the block
 * shape survives validation intact and reaches the service unchanged.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  submitted: null as any,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/utils/config', () => ({ Config: { ANTHROPIC_API_KEY: 'sk-test' } }));

vi.mock('@bike4mind/database', () => ({
  transformBatchRepository: { create: vi.fn(async () => ({ id: 'batch-row' })) },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  AnthropicBatchService: {
    fromApiKey: () => ({
      submitBatch: async (requests: any) => {
        mockRefs.submitted = requests;
        return { anthropicBatchId: 'msgbatch_test', customIdMap: [] };
      },
    }),
  },
}));

import '@pages/api/transforms/batch';

const PREFIX = 'You are a senior analytical editor. Follow these rules.';
const TAIL = 'ARTICLE:\nCentral bank holds rates steady';

function post(body: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = { id: 'u1' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  (req as any).requestId = 'req-1';
  (req as any).body = body;
  return { req, res };
}

/** The exact shape a batch consumer sends with the breakpoint on. */
const splitRequest = {
  client_ref: 'art-1',
  model: 'claude-opus-4-6',
  max_tokens: 8192,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: PREFIX, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: TAIL },
      ],
    },
  ],
};

describe('POST /api/transforms/batch -- cache_control pass-through', () => {
  beforeEach(() => {
    mockRefs.submitted = null;
  });

  it('accepts a two-block message and keeps the breakpoint on the prefix', async () => {
    const { req, res } = post({ requests: [splitRequest] });
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(202);
    const [prefix, tail] = mockRefs.submitted[0].messages[0].content;
    expect(prefix).toEqual({ type: 'text', text: PREFIX, cache_control: { type: 'ephemeral' } });
    expect(tail).toEqual({ type: 'text', text: TAIL });
  });

  it('keeps the two halves byte-identical to what was posted', async () => {
    const { req, res } = post({ requests: [splitRequest] });
    await mockRefs.postHandler!(req, res);

    const blocks = mockRefs.submitted[0].messages[0].content;
    expect(blocks.map((b: any) => b.text).join('')).toBe(PREFIX + TAIL);
  });

  it('carries an explicit 1h ttl through', async () => {
    const oneHour = structuredClone(splitRequest);
    (oneHour.messages[0].content[0] as any).cache_control = { type: 'ephemeral', ttl: '1h' };
    const { req, res } = post({ requests: [oneHour] });
    await mockRefs.postHandler!(req, res);

    expect(mockRefs.submitted[0].messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('still accepts a flat string, which is what the uncached path sends', async () => {
    const { req, res } = post({
      requests: [{ ...splitRequest, messages: [{ role: 'user', content: PREFIX + TAIL }] }],
    });
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(202);
    expect(mockRefs.submitted[0].messages[0].content).toBe(PREFIX + TAIL);
  });

  it('rejects an empty block array rather than submitting a contentless request', async () => {
    const { req, res } = post({
      requests: [{ ...splitRequest, messages: [{ role: 'user', content: [] }] }],
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(mockRefs.submitted).toBeNull();
  });

  it('rejects a block type batches cannot carry', async () => {
    const { req, res } = post({
      requests: [
        {
          ...splitRequest,
          messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'x' } }] }],
        },
      ],
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(mockRefs.submitted).toBeNull();
  });

  it('rejects a malformed cache_control instead of dropping it', async () => {
    const bad = structuredClone(splitRequest);
    (bad.messages[0].content[0] as any).cache_control = { type: 'permanent' };
    const { req, res } = post({ requests: [bad] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(mockRefs.submitted).toBeNull();
  });
});
