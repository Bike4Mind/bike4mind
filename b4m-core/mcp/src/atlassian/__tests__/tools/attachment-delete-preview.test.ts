import { describe, it, expect, vi, beforeEach } from 'vitest';

const jiraApi = vi.hoisted(() => ({ getAttachment: vi.fn(), deleteAttachment: vi.fn() }));
const confluenceApi = vi.hoisted(() => ({ getAttachment: vi.fn(), deleteAttachment: vi.fn() }));

vi.mock('../../client.js', () => ({
  getJiraApi: () => jiraApi,
  getConfluenceApi: () => confluenceApi,
}));

import { registerJiraAttachmentTools } from '../../tools/jira-attachments.js';
import { registerConfluenceAttachmentTools } from '../../tools/confluence-attachments.js';
import { JIRA_DELETE_ATTACHMENT, CONFLUENCE_DELETE_ATTACHMENT } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

const decodeToken = (token: unknown): { tool: string; params: Record<string, unknown> } =>
  JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'));

describe('attachment delete previews', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerJiraAttachmentTools(mock.server);
    registerConfluenceAttachmentTools(mock.server);
  });

  describe(JIRA_DELETE_ATTACHMENT, () => {
    it('names the file Jira reports for the attachment id, not the filename argument', async () => {
      jiraApi.getAttachment.mockResolvedValueOnce({ id: '10042', filename: 'payroll-2026.xlsx' });

      const result = await registeredTools.get(JIRA_DELETE_ATTACHMENT)!.handler({
        attachmentId: '10042',
        filename: 'old-screenshot.png',
      });

      expect(jiraApi.getAttachment).toHaveBeenCalledWith({ attachmentId: '10042' });
      const text = result.content[0].text;
      expect(text).toContain('payroll-2026.xlsx');
      expect(text).not.toContain('old-screenshot.png');
      const parsed = parseResponse(result);
      expect(decodeToken(parsed._confirmToken)).toMatchObject({
        tool: JIRA_DELETE_ATTACHMENT,
        params: { attachmentId: '10042', display_filename: 'payroll-2026.xlsx' },
      });
      expect(jiraApi.deleteAttachment).not.toHaveBeenCalled();
    });

    it('issues no confirm token when the attachment cannot be fetched', async () => {
      jiraApi.getAttachment.mockRejectedValueOnce(new Error('Jira API error (404)'));

      const result = await registeredTools.get(JIRA_DELETE_ATTACHMENT)!.handler({ attachmentId: '10042' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('_confirmToken');
    });
  });

  describe(CONFLUENCE_DELETE_ATTACHMENT, () => {
    it('names the file Confluence reports for the attachment id, not the filename argument', async () => {
      confluenceApi.getAttachment.mockResolvedValueOnce({ id: 'att123', title: 'contract-signed.pdf' });

      const result = await registeredTools.get(CONFLUENCE_DELETE_ATTACHMENT)!.handler({
        attachmentId: 'att123',
        filename: 'draft-notes.txt',
      });

      expect(confluenceApi.getAttachment).toHaveBeenCalledWith({ attachmentId: 'att123' });
      const text = result.content[0].text;
      expect(text).toContain('contract-signed.pdf');
      expect(text).not.toContain('draft-notes.txt');
      const parsed = parseResponse(result);
      expect(decodeToken(parsed._confirmToken)).toMatchObject({
        tool: CONFLUENCE_DELETE_ATTACHMENT,
        params: { attachmentId: 'att123', display_filename: 'contract-signed.pdf' },
      });
      expect(confluenceApi.deleteAttachment).not.toHaveBeenCalled();
    });

    it('issues no confirm token when the attachment cannot be fetched', async () => {
      confluenceApi.getAttachment.mockRejectedValueOnce(new Error('Confluence API error (404)'));

      const result = await registeredTools.get(CONFLUENCE_DELETE_ATTACHMENT)!.handler({ attachmentId: 'att123' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('_confirmToken');
    });
  });
});
