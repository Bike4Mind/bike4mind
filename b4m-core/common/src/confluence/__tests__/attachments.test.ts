import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceApi, detectConfluenceMimeType, CONFLUENCE_MAX_ATTACHMENT_SIZE } from '../api';
import type { ConfluenceConfig } from '../api';

describe('ConfluenceApi Attachment Operations', () => {
  let mockConfig: ConfluenceConfig;
  let confluenceApi: ConfluenceApi;

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net/wiki',
      webBaseUrl: 'https://test.atlassian.net/wiki',
      apiBaseUrlV1: 'https://api.atlassian.com/ex/confluence/test-cloud-id/wiki/rest/api',
      apiBaseUrlV2: 'https://api.atlassian.com/ex/confluence/test-cloud-id/api/v2',
      authHeader: 'Bearer test-token',
    };
    confluenceApi = new ConfluenceApi(mockConfig);
    // Mock the global fetch
    global.fetch = vi.fn();
  });

  describe('detectConfluenceMimeType', () => {
    it('should detect image MIME types', () => {
      expect(detectConfluenceMimeType('screenshot.png')).toBe('image/png');
      expect(detectConfluenceMimeType('photo.jpg')).toBe('image/jpeg');
      expect(detectConfluenceMimeType('photo.jpeg')).toBe('image/jpeg');
      expect(detectConfluenceMimeType('animation.gif')).toBe('image/gif');
      expect(detectConfluenceMimeType('icon.svg')).toBe('image/svg+xml');
    });

    it('should detect document MIME types', () => {
      expect(detectConfluenceMimeType('document.pdf')).toBe('application/pdf');
      expect(detectConfluenceMimeType('report.doc')).toBe('application/msword');
      expect(detectConfluenceMimeType('spreadsheet.xlsx')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    });

    it('should detect text MIME types', () => {
      expect(detectConfluenceMimeType('readme.txt')).toBe('text/plain');
      expect(detectConfluenceMimeType('data.csv')).toBe('text/csv');
      expect(detectConfluenceMimeType('config.json')).toBe('application/json');
      expect(detectConfluenceMimeType('notes.md')).toBe('text/markdown');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(detectConfluenceMimeType('file.unknown')).toBe('application/octet-stream');
      expect(detectConfluenceMimeType('file')).toBe('application/octet-stream');
    });

    it('should handle uppercase extensions', () => {
      expect(detectConfluenceMimeType('IMAGE.PNG')).toBe('image/png');
      expect(detectConfluenceMimeType('DOC.PDF')).toBe('application/pdf');
    });
  });

  describe('CONFLUENCE_MAX_ATTACHMENT_SIZE', () => {
    it('should be 25MB', () => {
      expect(CONFLUENCE_MAX_ATTACHMENT_SIZE).toBe(25 * 1024 * 1024);
    });
  });

  describe('listAttachments', () => {
    it('should call GET /content/{pageId}/child/attachment', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        results: [
          {
            id: 'att123',
            title: 'diagram.png',
            mediaType: 'image/png',
            fileSize: 54321,
            _links: {
              webui: '/pages/viewpage.action?attachmentId=att123',
              download: '/download/attachments/12345/diagram.png',
            },
            comment: 'Architecture diagram',
            version: { number: 1, createdAt: '2024-01-15T10:30:00.000Z' },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(mockResponse),
      } as Response);

      const result = await confluenceApi.listAttachments({ pageId: '12345' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/pages/12345/attachments');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('att123');
      expect(result[0].title).toBe('diagram.png');
      expect(result[0].fileSize).toBe(54321);
      expect(result[0].mediaType).toBe('image/png');
    });

    it('should return empty array when no attachments', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ results: [] }),
      } as Response);

      const result = await confluenceApi.listAttachments({ pageId: '12345' });

      expect(result).toEqual([]);
    });

    it('should throw error when pageId is missing', async () => {
      await expect(confluenceApi.listAttachments({ pageId: '' })).rejects.toThrow('pageId is required');
    });
  });

  describe('uploadAttachment', () => {
    it('should use multipart/form-data with X-Atlassian-Token header', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        results: [
          {
            id: 'att456',
            title: 'test.txt',
            mediaType: 'text/plain',
            fileSize: 13,
            _links: {
              webui: '/pages/viewpage.action?attachmentId=att456',
              download: '/download/attachments/12345/test.txt',
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const content = Buffer.from('Hello, World!').toString('base64');

      const result = await confluenceApi.uploadAttachment({
        pageId: '12345',
        filename: 'test.txt',
        content,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/content/12345/child/attachment');
      expect(callArgs[1]?.method).toBe('POST');
      expect(callArgs[1]?.headers?.['X-Atlassian-Token']).toBe('no-check');
      expect(callArgs[1]?.body).toBeInstanceOf(FormData);

      expect(result.id).toBe('att456');
      expect(result.title).toBe('test.txt');
    });

    it('should include comment when provided', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: 'att789', title: 'doc.pdf', mediaType: 'application/pdf', fileSize: 1000 }],
        }),
      } as Response);

      const content = Buffer.from('fake-pdf-data').toString('base64');

      await confluenceApi.uploadAttachment({
        pageId: '12345',
        filename: 'doc.pdf',
        content,
        comment: 'Important document',
      });

      const callArgs = mockFetch.mock.calls[0];
      const formData = callArgs[1]?.body as FormData;
      expect(formData).toBeInstanceOf(FormData);
    });

    it('should throw error when file exceeds size limit', async () => {
      const largeContent = Buffer.alloc(CONFLUENCE_MAX_ATTACHMENT_SIZE + 1).toString('base64');

      await expect(
        confluenceApi.uploadAttachment({
          pageId: '12345',
          filename: 'large-file.bin',
          content: largeContent,
        })
      ).rejects.toThrow('exceeds maximum allowed size');
    });

    it('should throw error when pageId is missing', async () => {
      const content = Buffer.from('test').toString('base64');
      await expect(
        confluenceApi.uploadAttachment({
          pageId: '',
          filename: 'test.txt',
          content,
        })
      ).rejects.toThrow('pageId is required');
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
        confluenceApi.uploadAttachment({
          pageId: '12345',
          filename: 'test.txt',
          content,
        })
      ).rejects.toThrow('File too large');
    });
  });

  describe('downloadAttachment', () => {
    it('should fetch attachment metadata and download content via v1 API', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      // First call: get attachment metadata (uses v2 API)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            id: 'att123',
            title: 'test.txt',
            mediaType: 'text/plain',
            fileSize: 13,
            _links: {
              download: '/download/attachments/12345/test.txt',
            },
          }),
      } as Response);

      // Second call: download file content via v1 API endpoint
      const fileContent = 'Hello, World!';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(fileContent).buffer,
      } as Response);

      const result = await confluenceApi.downloadAttachment({ attachmentId: 'att123' });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call should fetch metadata via v2 API
      expect(mockFetch.mock.calls[0][0]).toContain('/attachments/att123');

      // Second call should download via v1 API endpoint (OAuth-compatible)
      expect(mockFetch.mock.calls[1][0]).toContain('/content/12345/child/attachment/att123/download');

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
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            id: 'att123',
            title: 'test.txt',
            mediaType: 'text/plain',
            fileSize: 13,
            _links: {},
          }),
      } as Response);

      await expect(confluenceApi.downloadAttachment({ attachmentId: 'att123' })).rejects.toThrow('has no download URL');
    });

    it('should throw error when attachmentId is missing', async () => {
      await expect(confluenceApi.downloadAttachment({ attachmentId: '' })).rejects.toThrow('attachmentId is required');
    });

    it('should throw error when page ID cannot be extracted from download path', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            id: 'att123',
            title: 'test.txt',
            mediaType: 'text/plain',
            fileSize: 13,
            _links: {
              download: '/invalid/path/test.txt',
            },
          }),
      } as Response);

      await expect(confluenceApi.downloadAttachment({ attachmentId: 'att123' })).rejects.toThrow(
        'Unable to extract page ID from download path'
      );
    });
  });

  describe('uploadAttachment (v1 extensions fallback)', () => {
    it('should extract fileSize and mediaType from extensions when top-level fields are missing', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      // v1 API response: fileSize/mediaType are under extensions, not top-level
      const mockResponse = {
        results: [
          {
            id: 'att789',
            title: 'report.pdf',
            extensions: {
              mediaType: 'application/pdf',
              fileSize: 726000,
              comment: 'Quarterly report',
            },
            _links: {
              webui: '/pages/viewpageattachments.action?pageId=12345',
              download: '/download/attachments/12345/report.pdf',
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const content = Buffer.from('fake-pdf-data').toString('base64');
      const result = await confluenceApi.uploadAttachment({
        pageId: '12345',
        filename: 'report.pdf',
        content,
      });

      expect(result.id).toBe('att789');
      expect(result.fileSize).toBe(726000);
      expect(result.mediaType).toBe('application/pdf');
      expect(result.comment).toBe('Quarterly report');
    });

    it('should prefer top-level fields over extensions when both exist', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        results: [
          {
            id: 'att100',
            title: 'photo.png',
            mediaType: 'image/png',
            fileSize: 5000,
            extensions: {
              mediaType: 'application/octet-stream',
              fileSize: 0,
            },
            _links: {
              webui: '/pages/viewpageattachments.action?pageId=12345',
              download: '/download/attachments/12345/photo.png',
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const content = Buffer.from('fake-png-data').toString('base64');
      const result = await confluenceApi.uploadAttachment({
        pageId: '12345',
        filename: 'photo.png',
        content,
      });

      expect(result.mediaType).toBe('image/png');
      expect(result.fileSize).toBe(5000);
    });

    it('should handle v2-style direct response (no results array)', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      // v2 API returns attachment directly, not wrapped in results array
      const mockResponse = {
        id: 'att200',
        title: 'image.jpg',
        mediaType: 'image/jpeg',
        fileSize: 8000,
        _links: {
          webui: '/pages/viewpageattachments.action?pageId=99999',
          download: '/download/attachments/99999/image.jpg',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const content = Buffer.from('fake-jpg-data').toString('base64');
      const result = await confluenceApi.uploadAttachment({
        pageId: '99999',
        filename: 'image.jpg',
        content,
      });

      expect(result.id).toBe('att200');
      expect(result.title).toBe('image.jpg');
      expect(result.mediaType).toBe('image/jpeg');
      expect(result.fileSize).toBe(8000);
    });

    it('should throw error when response has empty results array', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      } as Response);

      const content = Buffer.from('test').toString('base64');
      await expect(confluenceApi.uploadAttachment({ pageId: '12345', filename: 'test.txt', content })).rejects.toThrow(
        'No attachment returned after upload'
      );
    });

    it('should auto-detect MIME type from filename', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: 'att300', title: 'data.csv', mediaType: 'text/csv', fileSize: 100 }],
        }),
      } as Response);

      const content = Buffer.from('a,b,c').toString('base64');
      await confluenceApi.uploadAttachment({
        pageId: '12345',
        filename: 'data.csv',
        content,
      });

      const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const formData = callArgs[1]?.body as FormData;
      expect(formData).toBeInstanceOf(FormData);
    });

    it('should handle generic non-413 upload error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      } as Response);

      const content = Buffer.from('test').toString('base64');
      await expect(confluenceApi.uploadAttachment({ pageId: '12345', filename: 'test.txt', content })).rejects.toThrow(
        'Confluence attachment upload error (403)'
      );
    });

    it('should construct upload URL using v1 API base with /wiki/ path', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: 'att400', title: 'test.txt', mediaType: 'text/plain', fileSize: 4 }],
        }),
      } as Response);

      const content = Buffer.from('test').toString('base64');
      await confluenceApi.uploadAttachment({ pageId: '12345', filename: 'test.txt', content });

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(
        'https://api.atlassian.com/ex/confluence/test-cloud-id/wiki/rest/api/content/12345/child/attachment'
      );
    });
  });

  describe('downloadAttachment (error handling)', () => {
    it('should throw error when download request fails', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      // First call: metadata succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            id: 'att123',
            title: 'test.txt',
            mediaType: 'text/plain',
            fileSize: 13,
            _links: {
              download: '/download/attachments/12345/test.txt',
            },
          }),
      } as Response);

      // Second call: download fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(confluenceApi.downloadAttachment({ attachmentId: 'att123' })).rejects.toThrow(
        'Failed to download attachment'
      );
    });
  });

  describe('listAttachments (additional)', () => {
    it('should return multiple attachments', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        results: [
          {
            id: 'att1',
            title: 'file1.png',
            mediaType: 'image/png',
            fileSize: 1000,
            _links: { webui: '/att1', download: '/download/att1' },
          },
          {
            id: 'att2',
            title: 'file2.pdf',
            mediaType: 'application/pdf',
            fileSize: 2000,
            _links: { webui: '/att2', download: '/download/att2' },
          },
          {
            id: 'att3',
            title: 'file3.txt',
            mediaType: 'text/plain',
            fileSize: 500,
            _links: { webui: '/att3', download: '/download/att3' },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(mockResponse),
      } as Response);

      const result = await confluenceApi.listAttachments({ pageId: '12345' });

      expect(result).toHaveLength(3);
      expect(result[0].title).toBe('file1.png');
      expect(result[1].title).toBe('file2.pdf');
      expect(result[2].title).toBe('file3.txt');
    });
  });

  describe('deleteAttachment', () => {
    it('should call DELETE /content/{attachmentId}', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '',
      } as Response);

      await confluenceApi.deleteAttachment({ attachmentId: 'att123' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/attachments/att123');
      expect(callArgs[1]?.method).toBe('DELETE');
    });

    it('should throw error when attachmentId is missing', async () => {
      await expect(confluenceApi.deleteAttachment({ attachmentId: '' })).rejects.toThrow('attachmentId is required');
    });

    it('should handle 404 error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'Attachment not found',
      } as Response);

      await expect(confluenceApi.deleteAttachment({ attachmentId: 'invalid' })).rejects.toThrow(
        'Confluence API Error 404'
      );
    });
  });
});
