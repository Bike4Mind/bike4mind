import { describe, it, expect, vi } from 'vitest';

const ssrfSafeDownload = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/fab-pipeline', () => ({ ssrfSafeDownload }));

import { downloadAttachmentUrl } from './downloadAttachmentUrl';

describe('downloadAttachmentUrl', () => {
  it('fetches through the SSRF-safe downloader with a byte cap and deadline', async () => {
    ssrfSafeDownload.mockResolvedValueOnce({ data: Buffer.from('file'), contentType: undefined, finalUrl: 'x' });

    const data = await downloadAttachmentUrl('https://files.example.com/a.txt');

    expect(data.toString()).toBe('file');
    expect(ssrfSafeDownload).toHaveBeenCalledWith('https://files.example.com/a.txt', {
      maxBytes: 50 * 1024 * 1024,
      timeoutMs: 30_000,
    });
  });

  it('propagates a guard refusal so callers do not upload empty content', async () => {
    ssrfSafeDownload.mockRejectedValueOnce(new Error('URL blocked for security reasons'));

    await expect(downloadAttachmentUrl('http://169.254.169.254/')).rejects.toThrow(/blocked/);
  });
});
