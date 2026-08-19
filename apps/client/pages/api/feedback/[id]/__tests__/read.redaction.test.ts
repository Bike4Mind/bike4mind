import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/feedback/[id]/read is a sibling of GET /api/feedback: both serve a reporter's full
 * promptMeta to any admin able to read the model, so both must redact functionCalls[].returnValue
 * the same way admin/model-logs.ts does.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => {
      mockRefs.getHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const { feedbackDoc } = vi.hoisted(() => ({
  feedbackDoc: {
    id: 'fb1',
    promptMeta: {
      functionCalls: [
        { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
      ],
    },
    toJSON: () => ({
      id: 'fb1',
      promptMeta: {
        functionCalls: [
          { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
        ],
      },
    }),
  },
}));

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: vi.fn().mockResolvedValue(feedbackDoc) },
}));

import '../read';

describe('GET /api/feedback/[id]/read - redacts tool output before returning it to an admin', () => {
  it('strips returnValue from functionCalls', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'fb1' } });
    (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };

    await mockRefs.getHandler!(req, res);

    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body).toContain('web_search');
  });
});
