import { describe, it, expect, vi } from 'vitest';
import { planUploads } from './planUploads';

const presign = vi.fn(async (key: string) => `https://s3.example/${key}`);
const base = { product: 'product-a', external_run_id: '100-1' };

describe('planUploads', () => {
  it('routes media and report files to their run-scoped areas', async () => {
    const res = await planUploads(
      {
        ...base,
        files: [
          { path: 'test-0/shot.png', kind: 'screenshot', content_type: 'image/png', bytes: 10 },
          { path: 'index.html', kind: 'report', content_type: 'text/html', bytes: 10 },
        ],
      },
      { presign }
    );
    expect(res.uploads.map(u => u.key)).toEqual([
      'product-a/100-1/media/test-0/shot.png',
      'product-a/100-1/report/index.html',
    ]);
    expect(res.rejected).toEqual([]);
    expect(presign).toHaveBeenCalledWith('product-a/100-1/media/test-0/shot.png', 'image/png', 10);
  });

  it('rejects oversize, wrong type, and unsafe paths without presigning them', async () => {
    presign.mockClear();
    const res = await planUploads(
      {
        ...base,
        files: [
          { path: 'big.png', kind: 'screenshot', content_type: 'image/png', bytes: 5 * 1024 * 1024 + 1 },
          { path: 'v.mp4', kind: 'video', content_type: 'video/mp4', bytes: 10 },
          { path: '../escape.html', kind: 'report', content_type: 'text/html', bytes: 10 },
        ],
      },
      { presign }
    );
    expect(res.uploads).toEqual([]);
    expect(res.rejected.map(r => r.path)).toEqual(['big.png', 'v.mp4', '../escape.html']);
    expect(presign).not.toHaveBeenCalled();
  });

  it('accepts a 50MB video and trace at the cap', async () => {
    const res = await planUploads(
      {
        ...base,
        files: [
          { path: 'v.webm', kind: 'video', content_type: 'video/webm', bytes: 50 * 1024 * 1024 },
          { path: 't.zip', kind: 'trace', content_type: 'application/zip', bytes: 50 * 1024 * 1024 },
        ],
      },
      { presign }
    );
    expect(res.uploads).toHaveLength(2);
  });
});
