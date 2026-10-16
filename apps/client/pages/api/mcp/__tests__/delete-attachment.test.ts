// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

// The route is baseApi().post(handler); unwrap it so the test drives the bare handler.
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { post: (fn: unknown) => unknown };
  const chain: Chain = { post: fn => fn };
  return { baseApi: () => chain };
});

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: vi.fn() }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: vi.fn() }));
vi.mock('@server/utils/parseMcpResult', () => ({ parseMcpResult: vi.fn(() => ({})) }));
vi.mock('@server/integrations/atlassian/confluenceAttachmentCleanup', () => ({
  cleanupConfluencePageContent: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Session: { findById: vi.fn() },
  Quest: { findOne: vi.fn(), updateOne: vi.fn() },
}));

vi.mock('@bike4mind/slack', () => {
  class StubResource {
    getMcpEnvVariables = vi.fn().mockResolvedValue([{ key: 'ATLASSIAN_ACCESS_TOKEN', value: 't' }]);
  }
  return { JiraResource: StubResource, ConfluenceResource: StubResource };
});

import { Quest, Session } from '@bike4mind/database';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { parseMcpResult } from '@server/utils/parseMcpResult';
import { cleanupConfluencePageContent } from '@server/integrations/atlassian/confluenceAttachmentCleanup';
import handler from '../delete-attachment';

const SESSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const routeHandler = handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

async function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'user-1' } });
  await routeHandler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

describe('POST /api/mcp/delete-attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Session.findById).mockResolvedValue({ userId: 'user-1' } as never);
    vi.mocked(invokeMcpHandler).mockResolvedValue({ content: [{ text: '{}' }] } as never);
  });

  it('refuses an attachment id that is in no listed attachment set and never invokes the tool', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue(null as never);

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'not-listed' });

    expect(res.statusCode).toBe(404);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
    expect(cleanupConfluencePageContent).not.toHaveBeenCalled();
    expect(vi.mocked(Quest.findOne).mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      'attachmentList.attachments.id': 'not-listed',
    });
  });

  it("deletes a listed attachment using the stored source under the requesting user's tenant, and cleans up the stored page id", async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: {
        source: 'confluence',
        pageId: '555',
        attachments: [{ id: 'att-1', filename: 'stored.png' }],
      },
    } as never);

    // Body values for the fields the route used to trust must be ignored.
    const res = await post({
      sessionId: SESSION_ID,
      attachmentId: 'att-1',
      source: 'jira',
      pageId: '999/../../x',
      filename: 'forged.png',
    });

    expect(res.statusCode).toBe(200);
    expect(invokeMcpHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'callTool',
        name: 'atlassian',
        userId: 'user-1',
        toolName: 'confluence_delete_attachment',
        toolArgs: expect.objectContaining({ attachmentId: 'att-1' }),
      })
    );
    expect(cleanupConfluencePageContent).toHaveBeenCalledWith(
      expect.anything(),
      '555',
      'stored.png',
      expect.anything()
    );
  });

  it('prunes the deleted entry from the stored list, scoped to the quest', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: { source: 'jira', attachments: [{ id: 'att-1', filename: 'a.png' }] },
    } as never);

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-1' });

    expect(res.statusCode).toBe(200);
    expect(Quest.updateOne).toHaveBeenCalledWith(
      { _id: 'quest-1' },
      { $pull: { 'attachmentList.attachments': { id: 'att-1' } } }
    );
  });

  it('reports a failed tool result as an error, without cleanup or pruning', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: {
        source: 'confluence',
        pageId: '555',
        attachments: [{ id: 'att-1', filename: 'stored.png' }],
      },
    } as never);
    vi.mocked(invokeMcpHandler).mockResolvedValue({
      content: [{ type: 'text', text: 'Error: permission denied' }],
      isError: true,
    } as never);

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-1' });

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toMatchObject({ success: false, error: 'Error: permission denied' });
    expect(cleanupConfluencePageContent).not.toHaveBeenCalled();
    expect(Quest.updateOne).not.toHaveBeenCalled();
  });

  it('refuses an id that is absent from a list the session does have', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: { source: 'jira', attachments: [{ id: 'att-1', filename: 'a.png' }] },
    } as never);

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-2' });

    expect(res.statusCode).toBe(404);
    expect(invokeMcpHandler).not.toHaveBeenCalled();
    expect(Quest.updateOne).not.toHaveBeenCalled();
  });

  it("refuses another user's session before reading its attachment list", async () => {
    vi.mocked(Session.findById).mockResolvedValue({ userId: 'user-2' } as never);

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-1' });

    expect(res.statusCode).toBe(403);
    expect(Quest.findOne).not.toHaveBeenCalled();
    expect(invokeMcpHandler).not.toHaveBeenCalled();
  });

  it('fails the request when the parsed tool payload carries an error, without pruning', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: {
        source: 'confluence',
        pageId: '555',
        attachments: [{ id: 'att-1', filename: 'stored.png' }],
      },
    } as never);
    vi.mocked(parseMcpResult).mockReturnValueOnce({ error: 'boom' });

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-1' });

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toMatchObject({ success: false, error: 'boom' });
    expect(Quest.updateOne).not.toHaveBeenCalled();
    expect(cleanupConfluencePageContent).not.toHaveBeenCalled();
  });

  it('still reports success when the Confluence page cannot be cleaned up after the delete', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: {
        source: 'confluence',
        pageId: '555',
        attachments: [{ id: 'att-1', filename: 'stored.png' }],
      },
    } as never);
    vi.mocked(cleanupConfluencePageContent).mockRejectedValueOnce(new Error('409 conflict'));

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-1' });

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(Quest.updateOne).toHaveBeenCalledWith(
      { _id: 'quest-1' },
      { $pull: { 'attachmentList.attachments': { id: 'att-1' } } }
    );
  });

  it('still reports success and cleans the page when pruning the stored list fails', async () => {
    vi.mocked(Quest.findOne).mockResolvedValue({
      _id: 'quest-1',
      attachmentList: {
        source: 'confluence',
        pageId: '555',
        attachments: [{ id: 'att-1', filename: 'stored.png' }],
      },
    } as never);
    vi.mocked(Quest.updateOne).mockRejectedValueOnce(new Error('mongo unavailable'));

    const res = await post({ sessionId: SESSION_ID, attachmentId: 'att-1' });

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(Quest.updateOne).toHaveBeenCalledWith(
      { _id: 'quest-1' },
      { $pull: { 'attachmentList.attachments': { id: 'att-1' } } }
    );
    expect(cleanupConfluencePageContent).toHaveBeenCalled();
  });
});
