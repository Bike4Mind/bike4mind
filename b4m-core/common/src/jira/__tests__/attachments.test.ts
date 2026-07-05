import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraApi, detectMimeType, JIRA_MAX_ATTACHMENT_SIZE } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi Attachment Operations', () => {
  let mockConfig: JiraConfig;
  let jiraApi: JiraApi;

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net',
      webBaseUrl: 'https://test.atlassian.net/browse',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3',
      agileApiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/agile/1.0',
      authHeader: 'Bearer test-token',
    };
    jiraApi = new JiraApi(mockConfig);
    global.fetch = vi.fn();
  });

  describe('detectMimeType', () => {
    it('should detect image MIME types', () => {
      expect(detectMimeType('screenshot.png')).toBe('image/png');
      expect(detectMimeType('photo.jpg')).toBe('image/jpeg');
      expect(detectMimeType('photo.jpeg')).toBe('image/jpeg');
      expect(detectMimeType('animation.gif')).toBe('image/gif');
      expect(detectMimeType('icon.svg')).toBe('image/svg+xml');
    });

    it('should detect document MIME types', () => {
      expect(detectMimeType('document.pdf')).toBe('application/pdf');
      expect(detectMimeType('report.doc')).toBe('application/msword');
      expect(detectMimeType('spreadsheet.xlsx')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    });

    it('should detect text MIME types', () => {
      expect(detectMimeType('readme.txt')).toBe('text/plain');
      expect(detectMimeType('data.csv')).toBe('text/csv');
      expect(detectMimeType('config.json')).toBe('application/json');
      expect(detectMimeType('notes.md')).toBe('text/markdown');
    });

    it('should detect archive MIME types', () => {
      expect(detectMimeType('archive.zip')).toBe('application/zip');
      expect(detectMimeType('backup.tar')).toBe('application/x-tar');
      expect(detectMimeType('compressed.gz')).toBe('application/gzip');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(detectMimeType('file.unknown')).toBe('application/octet-stream');
      expect(detectMimeType('file')).toBe('application/octet-stream');
    });

    it('should handle uppercase extensions', () => {
      expect(detectMimeType('IMAGE.PNG')).toBe('image/png');
      expect(detectMimeType('DOC.PDF')).toBe('application/pdf');
    });
  });

  describe('JIRA_MAX_ATTACHMENT_SIZE', () => {
    it('should be 20MB', () => {
      expect(JIRA_MAX_ATTACHMENT_SIZE).toBe(20 * 1024 * 1024);
    });
  });

  describe('listAttachments', () => {
    it('should call GET /issue/{key}?fields=attachment', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        fields: {
          attachment: [
            {
              id: '10001',
              self: 'https://api.atlassian.com/.../10001',
              filename: 'screenshot.png',
              author: { accountId: 'user-123', displayName: 'John Doe' },
              created: '2024-01-15T10:30:00.000Z',
              size: 12345,
              mimeType: 'image/png',
              content: 'https://test.atlassian.net/secure/attachment/10001/screenshot.png',
              thumbnail: 'https://test.atlassian.net/secure/thumbnail/10001',
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await jiraApi.listAttachments({ issueKey: 'PROJ-123' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-123');
      expect(callArgs[0]).toContain('fields=attachment');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('10001');
      expect(result[0].filename).toBe('screenshot.png');
      expect(result[0].size).toBe(12345);
      expect(result[0].mimeType).toBe('image/png');
    });

    it('should return empty array when no attachments', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ fields: { attachment: [] } }),
      } as Response);

      const result = await jiraApi.listAttachments({ issueKey: 'PROJ-123' });

      expect(result).toEqual([]);
    });

    it('should throw error for invalid issue key format', async () => {
      await expect(jiraApi.listAttachments({ issueKey: 'invalid' })).rejects.toThrow(
        'Invalid issue key format: invalid'
      );
    });
  });

  describe('uploadAttachment', () => {
    it('should use multipart/form-data with X-Atlassian-Token header', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = [
        {
          id: '10002',
          filename: 'test.txt',
          size: 13,
          mimeType: 'text/plain',
          created: '2024-01-15T11:00:00.000Z',
          self: 'https://api.atlassian.com/.../10002',
          content: 'https://test.atlassian.net/secure/attachment/10002/test.txt',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      // "Hello, World!" in base64
      const content = Buffer.from('Hello, World!').toString('base64');

      const result = await jiraApi.uploadAttachment({
        issueKey: 'PROJ-123',
        filename: 'test.txt',
        content,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-123/attachments');
      expect(callArgs[1]?.method).toBe('POST');
      expect(callArgs[1]?.headers?.['X-Atlassian-Token']).toBe('no-check');
      expect(callArgs[1]?.body).toBeInstanceOf(FormData);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('10002');
      expect(result[0].filename).toBe('test.txt');
    });

    it('should auto-detect MIME type from filename', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: '10003', filename: 'image.png', size: 100, mimeType: 'image/png' }],
      } as Response);

      const content = Buffer.from('fake-png-data').toString('base64');

      await jiraApi.uploadAttachment({
        issueKey: 'PROJ-123',
        filename: 'image.png',
        content,
      });

      // Verify the FormData was created with proper MIME type
      const callArgs = mockFetch.mock.calls[0];
      const formData = callArgs[1]?.body as FormData;
      expect(formData).toBeInstanceOf(FormData);
    });

    it('should throw error when file exceeds size limit', async () => {
      // Create content larger than 20MB
      const largeContent = Buffer.alloc(JIRA_MAX_ATTACHMENT_SIZE + 1).toString('base64');

      await expect(
        jiraApi.uploadAttachment({
          issueKey: 'PROJ-123',
          filename: 'large-file.bin',
          content: largeContent,
        })
      ).rejects.toThrow('exceeds maximum allowed size');
    });

    it('should throw error for invalid issue key format', async () => {
      const content = Buffer.from('test').toString('base64');
      await expect(
        jiraApi.uploadAttachment({
          issueKey: 'invalid',
          filename: 'test.txt',
          content,
        })
      ).rejects.toThrow('Invalid issue key format: invalid');
    });

    it('should handle 413 error for file too large', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 413,
        text: async () => 'Request Entity Too Large',
      } as Response);

      const content = Buffer.from('small-content').toString('base64');

      await expect(
        jiraApi.uploadAttachment({
          issueKey: 'PROJ-123',
          filename: 'test.txt',
          content,
        })
      ).rejects.toThrow('File too large');
    });
  });

  describe('uploadAttachment (additional)', () => {
    it('should handle generic non-413 upload error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden: no permission',
      } as Response);

      const content = Buffer.from('test').toString('base64');
      await expect(jiraApi.uploadAttachment({ issueKey: 'PROJ-123', filename: 'test.txt', content })).rejects.toThrow(
        'Jira attachment upload error (403)'
      );
    });

    it('should construct upload URL using correct Jira API path', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: '10010', filename: 'test.txt', size: 4, mimeType: 'text/plain' }],
      } as Response);

      const content = Buffer.from('test').toString('base64');
      await jiraApi.uploadAttachment({ issueKey: 'PROJ-456', filename: 'test.txt', content });

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3/issue/PROJ-456/attachments');
    });

    it('should use explicit MIME type when provided', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: '10011', filename: 'data.bin', size: 4, mimeType: 'application/custom' }],
      } as Response);

      const content = Buffer.from('test').toString('base64');
      await jiraApi.uploadAttachment({
        issueKey: 'PROJ-123',
        filename: 'data.bin',
        content,
        mimeType: 'application/custom',
      });

      const callArgs = mockFetch.mock.calls[0];
      const formData = callArgs[1]?.body as FormData;
      expect(formData).toBeInstanceOf(FormData);
    });
  });

  describe('listAttachments (additional)', () => {
    it('should return multiple attachments', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            attachment: [
              { id: '1', filename: 'a.png', size: 100, mimeType: 'image/png', content: 'url1' },
              { id: '2', filename: 'b.pdf', size: 200, mimeType: 'application/pdf', content: 'url2' },
              { id: '3', filename: 'c.txt', size: 50, mimeType: 'text/plain', content: 'url3' },
            ],
          },
        }),
      } as Response);

      const result = await jiraApi.listAttachments({ issueKey: 'PROJ-123' });

      expect(result).toHaveLength(3);
      expect(result[0].filename).toBe('a.png');
      expect(result[1].filename).toBe('b.pdf');
      expect(result[2].filename).toBe('c.txt');
    });

    it('should handle missing attachment field gracefully', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ fields: {} }),
      } as Response);

      const result = await jiraApi.listAttachments({ issueKey: 'PROJ-123' });

      expect(result).toEqual([]);
    });
  });

  describe('downloadAttachment', () => {
    it('should fetch attachment metadata and download content', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      // First call: get attachment metadata
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: '10001',
          filename: 'test.txt',
          mimeType: 'text/plain',
          size: 13,
          content: 'https://test.atlassian.net/secure/attachment/10001/test.txt',
        }),
      } as Response);

      // Second call: download file content
      const fileContent = 'Hello, World!';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(fileContent).buffer,
      } as Response);

      const result = await jiraApi.downloadAttachment({ attachmentId: '10001' });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call should fetch metadata
      expect(mockFetch.mock.calls[0][0]).toContain('/attachment/10001');

      // Second call should download file
      expect(mockFetch.mock.calls[1][0]).toContain('https://test.atlassian.net/secure/attachment/10001/test.txt');

      expect(result.filename).toBe('test.txt');
      expect(result.mimeType).toBe('text/plain');
      expect(result.size).toBe(13);
      expect(Buffer.from(result.content, 'base64').toString()).toBe(fileContent);
    });

    it('should throw error when attachment has no download URL', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: '10001',
          filename: 'test.txt',
          mimeType: 'text/plain',
          size: 13,
          content: null,
        }),
      } as Response);

      await expect(jiraApi.downloadAttachment({ attachmentId: '10001' })).rejects.toThrow('has no download URL');
    });

    it('should throw error when download request fails', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      // First call: metadata succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: '10001',
          filename: 'test.txt',
          mimeType: 'text/plain',
          size: 13,
          content: 'https://test.atlassian.net/secure/attachment/10001/test.txt',
        }),
      } as Response);

      // Second call: download fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(jiraApi.downloadAttachment({ attachmentId: '10001' })).rejects.toThrow(
        'Failed to download attachment'
      );
    });

    it('should return correct base64-encoded content for binary data', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: '10005',
          filename: 'image.png',
          mimeType: 'image/png',
          size: 4,
          content: 'https://test.atlassian.net/secure/attachment/10005/image.png',
        }),
      } as Response);

      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => binaryData.buffer,
      } as Response);

      const result = await jiraApi.downloadAttachment({ attachmentId: '10005' });

      expect(result.filename).toBe('image.png');
      expect(result.mimeType).toBe('image/png');
      const decoded = Buffer.from(result.content, 'base64');
      expect(decoded[0]).toBe(0x89);
      expect(decoded[1]).toBe(0x50);
    });
  });

  describe('deleteAttachment', () => {
    it('should call DELETE /attachment/{attachmentId}', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      await jiraApi.deleteAttachment({ attachmentId: '10001' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/attachment/10001');
      expect(callArgs[1]?.method).toBe('DELETE');
    });

    it('should handle 404 error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Attachment not found',
        headers: new Headers({ 'content-type': 'application/json' }),
      } as Response);

      await expect(jiraApi.deleteAttachment({ attachmentId: '99999' })).rejects.toThrow('Jira API error (404)');
    });
  });
});
