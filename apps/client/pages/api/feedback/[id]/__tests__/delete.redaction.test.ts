import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/feedback/[id] is a sibling of GET/PUT on this collection: an admin deleting
 * another reporter's feedback still sees the response body, so it must redact
 * functionCalls[].returnValue the same way the read/update routes do.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    delete: (fn: unknown) => {
      mockRefs.deleteHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const { deletedFeedbackDoc } = vi.hoisted(() => {
  const promptMeta = {
    functionCalls: [
      { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
    ],
  };
  const plain = { id: 'fb1', promptMeta };
  return { deletedFeedbackDoc: { ...plain, toJSON: () => plain } };
});

vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findOneAndDelete: vi.fn().mockResolvedValue(deletedFeedbackDoc) },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '../delete';

describe('DELETE /api/feedback/[id] - redacts tool output before returning it to an admin', () => {
  it('strips returnValue from functionCalls', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'fb1' } });
    (req as unknown as { ability: { can: () => boolean }; user: { id: string } }).ability = { can: () => true };
    (req as unknown as { user: { id: string } }).user = { id: 'admin1' };

    await mockRefs.deleteHandler!(req, res);

    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toContain('PRIVATE TOOL OUTPUT');
    expect(body).toContain('web_search');
  });
});
