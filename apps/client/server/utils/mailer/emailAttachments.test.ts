import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';

const { mockPublish, mockUpload, mockSign } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockUpload: vi.fn(),
  mockSign: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('sst', () => ({ Resource: { JWT_SECRET: { value: 'test-jwt-secret' } } }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: mockUpload, getSignedUrl: mockSign }),
}));

import { verifyFileLinkToken } from '@bike4mind/server-utils/files/fileLinkToken';
import {
  SHARED_EMAIL_FILES_PREFIX,
  SHARED_EMAIL_FILE_LINK_TTL_DAYS,
  sendEmailWithAttachments,
} from './emailAttachments';

const originalAppUrl = process.env.APP_URL;
beforeAll(() => {
  process.env.APP_URL = 'https://app.example.com';
});
afterAll(() => {
  process.env.APP_URL = originalAppUrl;
});
beforeEach(() => {
  vi.clearAllMocks();
  mockUpload.mockResolvedValue(undefined);
});

const sendLarge = (filename = 'report.bin', userName = 'Pat') =>
  sendEmailWithAttachments(
    {
      to: 'a@example.com',
      subject: 's',
      body: '<html><body>hi</body></html>',
      attachments: [{ filename, content: Buffer.alloc(300 * 1024), contentType: 'application/octet-stream' }],
    },
    'user-1',
    userName
  );

describe('sendEmailWithAttachments download-links body', () => {
  it('escapes the sender name and file names when attachments exceed the event size limit', async () => {
    const result = await sendLarge('<u>f</u>.bin', '<script>x</script>');

    expect(result.method).toBe('download-links');
    const body: string = mockPublish.mock.calls[0][0].body;
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).toContain('&lt;u&gt;f&lt;/u&gt;.bin');
  });

  it('stores under the sender id and links through the app instead of a storage URL', async () => {
    const before = Math.floor(Date.now() / 1000);
    await sendLarge();

    const key: string = mockUpload.mock.calls[0][1];
    expect(key.startsWith(`${SHARED_EMAIL_FILES_PREFIX}user-1/`)).toBe(true);
    expect(mockSign).not.toHaveBeenCalled();

    const body: string = mockPublish.mock.calls[0][0].body;
    const token = body.match(/href="https:\/\/app\.example\.com\/api\/file-links\/([^"]+)"/)?.[1];
    const check = verifyFileLinkToken(token, before);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.claims.target).toEqual({ kind: 'filesKey', key });
    expect(check.claims.userId).toBe('user-1');
    const ttl = SHARED_EMAIL_FILE_LINK_TTL_DAYS * 86400;
    expect(check.claims.exp - before).toBeGreaterThanOrEqual(ttl);
    expect(check.claims.exp - before).toBeLessThanOrEqual(ttl + 2);
    expect(body).toContain(`expire in ${SHARED_EMAIL_FILE_LINK_TTL_DAYS} days`);
  });
});
