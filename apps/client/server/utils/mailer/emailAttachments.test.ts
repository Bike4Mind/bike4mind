import { describe, it, expect, vi } from 'vitest';

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({
    upload: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue('https://files.example.com/x'),
  }),
}));

import { sendEmailWithAttachments } from './emailAttachments';

describe('sendEmailWithAttachments download-links body', () => {
  it('escapes the sender name and file names when attachments exceed the event size limit', async () => {
    const result = await sendEmailWithAttachments(
      {
        to: 'a@example.com',
        subject: 's',
        body: '<html><body>hi</body></html>',
        attachments: [
          { filename: '<u>f</u>.bin', content: Buffer.alloc(300 * 1024), contentType: 'application/octet-stream' },
        ],
      },
      'pat@example.com',
      '<script>x</script>'
    );

    expect(result.method).toBe('download-links');
    const body: string = mockPublish.mock.calls[0][0].body;
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).toContain('&lt;u&gt;f&lt;/u&gt;.bin');
  });
});
