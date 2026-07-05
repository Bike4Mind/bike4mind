import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  getConfig: vi.fn(() => ({
    accessToken: 'mock-token',
    writeEnabled: true,
    rootPageId: 'root-page-00-0000-000000000000',
    accessMode: 'all',
    allowedPages: [],
    excludedPageIds: [],
  })),
  getEnvSignature: () => '{"accessToken":"mock-token"}',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  notionRequest: vi.fn(),
}));

import { registerPageTools } from '../../tools/pages.js';
import { notionRequest } from '../../client.js';
import { getConfig } from '../../config.js';
import { TOOL_NOTION_CREATE_PAGE, TOOL_NOTION_APPEND_BLOCKS, TOOL_NOTION_READ_PAGE } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

/**
 * Helper to set up ancestry mock: target page's parent is the root page.
 * The first call(s) are for ancestry validation (GET /pages/{id}),
 * and the last call is the actual write operation.
 */
function mockAncestryThenWrite(writeResponse: Record<string, unknown>) {
  // First call: ancestry check - GET /pages/{targetId} returns parent pointing to root
  vi.mocked(notionRequest)
    .mockResolvedValueOnce({
      id: 'target-page-id',
      object: 'page',
      parent: { type: 'page_id', page_id: 'root-page-00-0000-000000000000' },
    })
    // Second call: the actual write operation
    .mockResolvedValueOnce(writeResponse);
}

/**
 * Helper to mock ancestry for a page that IS the root page itself.
 */
function mockRootPageWrite(writeResponse: Record<string, unknown>) {
  vi.mocked(notionRequest).mockResolvedValueOnce(writeResponse);
}

const ROOT_PAGE_ID = 'root-page-00-0000-000000000000';
const ALLOWED_PAGE_ID = 'aaaa1111-bbbb-cccc-dddd-eeee22223333';

describe('Page Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to defaults: write enabled, root page set, access mode 'all'
    vi.mocked(getConfig).mockReturnValue({
      accessToken: 'mock-token',
      writeEnabled: true,
      rootPageId: ROOT_PAGE_ID,
      accessMode: 'all',
      allowedPages: [],
      excludedPageIds: [],
    });
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerPageTools(mock.server);
  });

  describe(TOOL_NOTION_CREATE_PAGE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_NOTION_CREATE_PAGE)).toBe(true);
    });

    it('should create a page under root page when no parent specified', async () => {
      // No ancestry check needed - defaults to root page
      mockRootPageWrite({
        id: 'new-page-id',
        url: 'https://notion.so/new-page',
        object: 'page',
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'New Page' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe('new-page-id');

      // Should use root page as parent, not workspace
      expect(notionRequest).toHaveBeenCalledWith('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { page_id: ROOT_PAGE_ID },
          properties: {
            title: { title: [{ text: { content: 'New Page' } }] },
          },
        }),
      });
    });

    it('should create a page under an explicit parent within root tree', async () => {
      const parentId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

      // Ancestry check: parent is child of root
      vi.mocked(notionRequest)
        .mockResolvedValueOnce({
          id: parentId,
          object: 'page',
          parent: { type: 'page_id', page_id: ROOT_PAGE_ID },
        })
        .mockResolvedValueOnce({
          id: 'child-page-id',
          url: 'https://notion.so/child-page',
          object: 'page',
        });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'Child Page', parentPageId: parentId });

      expect(result.isError).toBeUndefined();
    });

    it('should reject explicit parentPageId outside root tree', async () => {
      const outsideId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

      // Ancestry check: parent is under workspace, not root
      vi.mocked(notionRequest).mockResolvedValueOnce({
        id: outsideId,
        object: 'page',
        parent: { type: 'workspace', workspace: true },
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'Outside', parentPageId: outsideId });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('not within the configured root page tree');
    });

    it('should create a page in a database', async () => {
      // Database parent bypasses page ancestry check
      mockRootPageWrite({
        id: 'db-page-id',
        url: 'https://notion.so/db-page',
        object: 'page',
      });

      const dbId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'DB Entry', parentDatabaseId: dbId });

      expect(result.isError).toBeUndefined();
      expect(notionRequest).toHaveBeenCalledWith('/pages', {
        method: 'POST',
        body: expect.stringContaining(`"database_id":"${dbId}"`),
      });
    });

    it('should prefer database parent over page parent when both provided', async () => {
      mockRootPageWrite({
        id: 'page-id',
        url: 'https://notion.so/page',
        object: 'page',
      });

      const dbId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const pageId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      await tool!.handler({ title: 'Test', parentDatabaseId: dbId, parentPageId: pageId });

      // Should not have made an ancestry check call (database takes priority)
      expect(notionRequest).toHaveBeenCalledTimes(1);
      expect(notionRequest).toHaveBeenCalledWith('/pages', {
        method: 'POST',
        body: expect.stringContaining(`"database_id":"${dbId}"`),
      });
    });

    it('should include content block when content is provided', async () => {
      mockRootPageWrite({
        id: 'page-with-content',
        url: 'https://notion.so/page',
        object: 'page',
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      await tool!.handler({ title: 'With Content', content: 'Hello world' });

      const callBody = JSON.parse((vi.mocked(notionRequest).mock.calls[0][1] as { body: string }).body);
      expect(callBody.children).toHaveLength(1);
      expect(callBody.children[0].type).toBe('paragraph');
      expect(callBody.children[0].paragraph.rich_text[0].text.content).toBe('Hello world');
    });

    it('should not include children when content is not provided', async () => {
      mockRootPageWrite({
        id: 'page-id',
        object: 'page',
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      await tool!.handler({ title: 'No Content' });

      const callBody = JSON.parse((vi.mocked(notionRequest).mock.calls[0][1] as { body: string }).body);
      expect(callBody.children).toBeUndefined();
    });

    it('should return error response on API failure', async () => {
      vi.mocked(notionRequest).mockRejectedValueOnce(new Error('Notion API error: 403 Forbidden'));

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'Will Fail' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('403');
    });

    // --- Write access guardrail tests ---

    it('should reject when write access is disabled', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: false,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'all',
        allowedPages: [],
        excludedPageIds: [],
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'Blocked' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('write access is disabled');
      expect(notionRequest).not.toHaveBeenCalled();
    });

    it('should reject when no root page is configured', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: null,
        accessMode: 'all',
        allowedPages: [],
        excludedPageIds: [],
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'No Root' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('root page');
      expect(notionRequest).not.toHaveBeenCalled();
    });
  });

  describe(TOOL_NOTION_APPEND_BLOCKS, () => {
    const blockId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_NOTION_APPEND_BLOCKS)).toBe(true);
    });

    it('should append paragraph blocks to a page within root tree', async () => {
      mockAncestryThenWrite({
        object: 'list',
        results: [{ id: 'block-1', type: 'paragraph', object: 'block' }],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId,
        blocks: [{ type: 'paragraph', text: 'Hello world' }],
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.appended).toBe(1);
      expect(parsed.blockIds).toEqual(['block-1']);
    });

    it('should allow appending directly to root page', async () => {
      const rootId = ROOT_PAGE_ID;

      // No ancestry API call needed - target IS the root page
      vi.mocked(notionRequest).mockResolvedValueOnce({
        object: 'list',
        results: [{ id: 'block-1', type: 'paragraph', object: 'block' }],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId: rootId,
        blocks: [{ type: 'paragraph', text: 'Directly on root' }],
      });

      expect(result.isError).toBeUndefined();
      // Only 1 call (the PATCH), no ancestry check
      expect(notionRequest).toHaveBeenCalledTimes(1);
    });

    it('should reject appending to a page outside root tree', async () => {
      // Ancestry check: page is under workspace, not root
      vi.mocked(notionRequest).mockResolvedValueOnce({
        id: blockId,
        object: 'page',
        parent: { type: 'workspace', workspace: true },
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId,
        blocks: [{ type: 'paragraph', text: 'Outside root' }],
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('not within the configured root page tree');
    });

    it('should append multiple block types', async () => {
      mockAncestryThenWrite({
        object: 'list',
        results: [
          { id: 'block-1', type: 'heading_1', object: 'block' },
          { id: 'block-2', type: 'paragraph', object: 'block' },
          { id: 'block-3', type: 'bulleted_list_item', object: 'block' },
        ],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId,
        blocks: [
          { type: 'heading_1', text: 'Title' },
          { type: 'paragraph', text: 'Body text' },
          { type: 'bulleted_list_item', text: 'Item 1' },
        ],
      });

      const parsed = parseResponse(result);
      expect(parsed.appended).toBe(3);
      expect(parsed.blockIds).toEqual(['block-1', 'block-2', 'block-3']);
    });

    it('should handle to_do blocks with checked state', async () => {
      mockAncestryThenWrite({
        object: 'list',
        results: [{ id: 'block-1', type: 'to_do', object: 'block' }],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      await tool!.handler({
        blockId,
        blocks: [{ type: 'to_do', text: 'Task', checked: true }],
      });

      // The PATCH call is the second one (after ancestry check)
      const patchCall = vi.mocked(notionRequest).mock.calls[1];
      const callBody = JSON.parse((patchCall[1] as { body: string }).body);
      expect(callBody.children[0].to_do.checked).toBe(true);
    });

    it('should handle code blocks with language', async () => {
      mockAncestryThenWrite({
        object: 'list',
        results: [{ id: 'block-1', type: 'code', object: 'block' }],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      await tool!.handler({
        blockId,
        blocks: [{ type: 'code', text: 'const x = 1;', language: 'typescript' }],
      });

      const patchCall = vi.mocked(notionRequest).mock.calls[1];
      const callBody = JSON.parse((patchCall[1] as { body: string }).body);
      expect(callBody.children[0].code.language).toBe('typescript');
      expect(callBody.children[0].code.rich_text[0].text.content).toBe('const x = 1;');
    });

    it('should handle divider blocks (no text needed)', async () => {
      mockAncestryThenWrite({
        object: 'list',
        results: [{ id: 'block-1', type: 'divider', object: 'block' }],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      await tool!.handler({
        blockId,
        blocks: [{ type: 'divider' }],
      });

      const patchCall = vi.mocked(notionRequest).mock.calls[1];
      const callBody = JSON.parse((patchCall[1] as { body: string }).body);
      expect(callBody.children[0]).toEqual({ object: 'block', type: 'divider', divider: {} });
    });

    it('should return error response on API failure', async () => {
      // Ancestry passes, but write fails
      vi.mocked(notionRequest)
        .mockResolvedValueOnce({
          id: blockId,
          object: 'page',
          parent: { type: 'page_id', page_id: ROOT_PAGE_ID },
        })
        .mockRejectedValueOnce(new Error('Notion API error: 404 Not Found'));

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId,
        blocks: [{ type: 'paragraph', text: 'Will fail' }],
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('404');
    });

    // --- Write access guardrail tests ---

    it('should reject when write access is disabled', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: false,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'all',
        allowedPages: [],
        excludedPageIds: [],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId,
        blocks: [{ type: 'paragraph', text: 'Blocked' }],
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('write access is disabled');
      expect(notionRequest).not.toHaveBeenCalled();
    });

    it('should reject when no root page is configured', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: null,
        accessMode: 'all',
        allowedPages: [],
        excludedPageIds: [],
      });

      const tool = registeredTools.get(TOOL_NOTION_APPEND_BLOCKS);
      const result = await tool!.handler({
        blockId,
        blocks: [{ type: 'paragraph', text: 'No root' }],
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('root page');
      expect(notionRequest).not.toHaveBeenCalled();
    });
  });

  describe(TOOL_NOTION_READ_PAGE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_NOTION_READ_PAGE)).toBe(true);
    });

    it('should read page blocks and flatten text content', async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [
          {
            object: 'block',
            id: 'block-1',
            type: 'paragraph',
            has_children: false,
            paragraph: {
              rich_text: [{ plain_text: 'Meeting notes' }],
            },
          },
          {
            object: 'block',
            id: 'block-2',
            type: 'to_do',
            has_children: false,
            to_do: {
              rich_text: [{ plain_text: 'Follow up with design' }],
              checked: true,
            },
          },
          {
            object: 'block',
            id: 'block-3',
            type: 'child_page',
            has_children: true,
            child_page: {
              title: 'Nested notes',
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });

      expect(result.isError).toBeUndefined();
      expect(notionRequest).toHaveBeenCalledWith(
        '/blocks/a1b2c3d4-e5f6-7890-abcd-ef1234567890/children?page_size=100',
        {
          method: 'GET',
        }
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(3);
      expect(parsed.plain_text).toBe('Meeting notes\nFollow up with design\nNested notes');
      expect((parsed.blocks as Array<Record<string, unknown>>)[1].checked).toBe(true);
    });

    it('should pass pagination params when provided', async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [],
        has_more: true,
        next_cursor: 'next-blocks',
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      await tool!.handler({
        pageId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        page_size: 25,
        start_cursor: 'cursor-123',
      });

      expect(notionRequest).toHaveBeenCalledWith(
        '/blocks/a1b2c3d4-e5f6-7890-abcd-ef1234567890/children?page_size=25&start_cursor=cursor-123',
        {
          method: 'GET',
        }
      );
    });

    it('should return error response on read failure', async () => {
      vi.mocked(notionRequest).mockRejectedValueOnce(new Error('Notion API error: 404 Not Found'));

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('404');
      expect(parsed.pageId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });
  });

  describe('page-level access control (checkPageAccess)', () => {
    it('should allow all access in "all" mode (no restrictions)', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'all',
        allowedPages: [],
        excludedPageIds: [],
      });

      // read_page in 'all' mode - no access check API calls
      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: ALLOWED_PAGE_ID });

      expect(result.isError).toBeUndefined();
      // Only the read call, no access check
      expect(notionRequest).toHaveBeenCalledTimes(1);
    });

    it('should deny all access when selected mode has empty allowedPages', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [],
        excludedPageIds: [],
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: ALLOWED_PAGE_ID });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('No pages are configured for access');
      expect(notionRequest).not.toHaveBeenCalled();
    });

    it('should allow read access to a directly allowed page', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      vi.mocked(notionRequest).mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: ALLOWED_PAGE_ID });

      expect(result.isError).toBeUndefined();
    });

    it('should deny access to an explicitly excluded page', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [ALLOWED_PAGE_ID],
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: ALLOWED_PAGE_ID });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('explicitly excluded');
    });

    it('should deny write access to a read-only allowed page', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ROOT_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'Test' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('Write access denied');
    });

    it('should allow write access to a readwrite allowed page', async () => {
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ROOT_PAGE_ID, access: 'readwrite' }],
        excludedPageIds: [],
      });

      mockRootPageWrite({
        id: 'new-page-id',
        url: 'https://notion.so/page',
        object: 'page',
      });

      const tool = registeredTools.get(TOOL_NOTION_CREATE_PAGE);
      const result = await tool!.handler({ title: 'Test' });

      expect(result.isError).toBeUndefined();
    });

    it('should allow access to a page via ancestor in the allowed list (findAllowedAncestor)', async () => {
      const childId = 'cccc1111-dddd-eeee-ffff-000011112222';
      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      // Ancestry walk: child's parent is the allowed page
      vi.mocked(notionRequest)
        .mockResolvedValueOnce({
          id: childId,
          parent: { type: 'page_id', page_id: ALLOWED_PAGE_ID },
        })
        // Then the actual read call
        .mockResolvedValueOnce({
          results: [],
          has_more: false,
          next_cursor: null,
        });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: childId });

      expect(result.isError).toBeUndefined();
    });

    it('should deny access when ancestor walk encounters an excluded page', async () => {
      const childId = 'cccc1111-dddd-eeee-ffff-000011112222';
      const excludedMiddle = 'bbbb1111-cccc-dddd-eeee-ffff00001111';

      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [excludedMiddle],
      });

      // Ancestry walk: child's parent is the excluded middle page
      vi.mocked(notionRequest).mockResolvedValueOnce({
        id: childId,
        parent: { type: 'page_id', page_id: excludedMiddle },
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: childId });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('not within any allowed page scope');
    });

    it('should deny access when page has no allowed ancestor', async () => {
      const orphanId = 'dddd1111-eeee-ffff-0000-111122223333';

      vi.mocked(getConfig).mockReturnValue({
        accessToken: 'mock-token',
        writeEnabled: true,
        rootPageId: ROOT_PAGE_ID,
        accessMode: 'selected',
        allowedPages: [{ id: ALLOWED_PAGE_ID, access: 'read' }],
        excludedPageIds: [],
      });

      // Ancestry walk: page is under workspace (no allowed ancestor)
      vi.mocked(notionRequest).mockResolvedValueOnce({
        id: orphanId,
        parent: { type: 'workspace', workspace: true },
      });

      const tool = registeredTools.get(TOOL_NOTION_READ_PAGE);
      const result = await tool!.handler({ pageId: orphanId });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('not within any allowed page scope');
    });
  });
});
