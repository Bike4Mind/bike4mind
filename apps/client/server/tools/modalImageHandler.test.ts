// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.hoisted(() => vi.fn());
const findOne = vi.hoisted(() => vi.fn());

vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = send;
  },
  CopyObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@bike4mind/database', () => ({ FabFile: { findOne } }));
vi.mock('@bike4mind/common', () => ({ isImageServeable: (f: { ok: boolean }) => f.ok }));
vi.mock('./modalImageUrls', () => ({
  MODAL_IMAGE_PREFIX: 'modal-images/',
  extractModalImageKey: (v: string) => (v.startsWith('modal-images/') ? v : null),
}));

import { ModalImageHandler } from './modalImageHandler';

const SIGNED = 'https://test-bucket.s3.amazonaws.com/uploads/abc.png?X-Amz-Algorithm=AWS4&X-Amz-Signature=sig';

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockResolvedValue(null);
  send.mockResolvedValue({});
});

describe('ModalImageHandler.processModalImageUrl', () => {
  it('copies the object and returns the bare key with no signature parameters', async () => {
    const result = await ModalImageHandler.processModalImageUrl(SIGNED);

    expect(result).toMatch(/^modal-images\/[0-9a-f-]+\.png$/);
    expect(result).not.toContain('X-Amz');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('leaves external URLs unchanged', async () => {
    expect(await ModalImageHandler.processModalImageUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an image that is not serveable', async () => {
    findOne.mockResolvedValue({ ok: false });
    await expect(ModalImageHandler.processModalImageUrl(SIGNED)).rejects.toThrow(/not available/);
    expect(send).not.toHaveBeenCalled();
  });
});
