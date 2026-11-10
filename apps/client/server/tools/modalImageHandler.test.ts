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
vi.mock('@bike4mind/common', () => ({
  isImageServeable: (f: { ok: boolean }) => f.ok,
  BadRequestError: class extends Error {
    status = 400;
  },
}));
vi.mock('./modalImageUrls', () => ({
  MODAL_IMAGE_PREFIX: 'modal-images/',
  extractModalImageKey: (v: string) => (v.startsWith('modal-images/') ? v : null),
}));

import { ModalImageHandler, bucketObjectKey } from './modalImageHandler';

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

  it('refuses an image that is not serveable with a 400', async () => {
    findOne.mockResolvedValue({ ok: false });
    await expect(ModalImageHandler.processModalImageUrl(SIGNED)).rejects.toMatchObject({
      message: expect.stringMatching(/not available/),
      status: 400,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('copies from the full object key and checks moderation on it', async () => {
    await ModalImageHandler.processModalImageUrl(SIGNED);

    expect(findOne).toHaveBeenCalledWith({ filePath: 'uploads/abc.png' });
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'test-bucket',
      CopySource: 'test-bucket/uploads/abc.png',
    });
  });

  it('copies an unsigned object URL from the bucket too', async () => {
    const result = await ModalImageHandler.processModalImageUrl(
      'https://test-bucket.s3.us-east-2.amazonaws.com/modals/x%20y.png'
    );

    expect(result).toMatch(/^modal-images\/[0-9a-f-]+\.png$/);
    expect(send.mock.calls[0][0].input).toMatchObject({ CopySource: 'test-bucket/modals/x%20y.png' });
  });

  it('stores the object URL without its signature when the copy fails', async () => {
    send.mockRejectedValue(new Error('NoSuchKey'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await ModalImageHandler.processModalImageUrl(SIGNED)).toBe(
      'https://test-bucket.s3.amazonaws.com/uploads/abc.png'
    );
  });

  it('strips the signature from a signed URL for another bucket without copying it', async () => {
    const result = await ModalImageHandler.processModalImageUrl(
      'https://other-bucket.s3.amazonaws.com/a.png?X-Amz-Algorithm=AWS4&X-Amz-Signature=sig'
    );

    expect(result).toBe('https://other-bucket.s3.amazonaws.com/a.png');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('bucketObjectKey', () => {
  it.each([
    ['https://b.s3.amazonaws.com/modals/a.png', 'modals/a.png'],
    ['https://b.s3.us-east-2.amazonaws.com/modals/a.png?X-Amz-Signature=s', 'modals/a.png'],
    ['https://s3.us-east-2.amazonaws.com/b/modals/a.png', 'modals/a.png'],
    ['https://b.s3.amazonaws.com/a%20b.png', 'a b.png'],
  ])('reads the full key from %s', (url, key) => {
    expect(bucketObjectKey(url, 'b')).toBe(key);
  });

  it.each([
    'https://other.s3.amazonaws.com/a.png',
    'https://s3.amazonaws.com/other/a.png',
    'https://b.s3.example.com/a.png',
    'not a url',
  ])('returns null for %s', url => {
    expect(bucketObjectKey(url, 'b')).toBeNull();
  });
});
