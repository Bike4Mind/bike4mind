import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock for the Lambda client's send method so we can assert on calls.
const { mockSend, mockAxiosGet } = vi.hoisted(() => ({ mockSend: vi.fn(), mockAxiosGet: vi.fn() }));

vi.mock('axios', () => ({ default: { get: mockAxiosGet } }));

vi.mock('@aws-sdk/client-lambda', () => ({
  // Must be a class - the SUT calls `new LambdaClient({})`, and an arrow fn
  // cannot be used as a constructor.
  LambdaClient: class {
    send = mockSend;
  },
  // Echo the args back so tests can inspect the payload that was built.
  InvokeCommand: class {
    input: unknown;
    constructor(args: unknown) {
      this.input = args;
    }
  },
}));

import { invokeImageProcessor, downloadImageAsBuffer } from './imageProcessorUtils';

// A public IPv4 literal, so the guard's pre-flight skips DNS and the suite makes no network calls.
const PUBLIC_HOST = 'https://93.184.216.34';

const LAMBDA_NAME = 'test-image-processor';

// PNG magic bytes prefix: 0x89 0x50 0x4E 0x47
function makePngBuffer(totalBytes: number): Buffer {
  const buf = Buffer.alloc(totalBytes);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}

// Non-PNG buffer (all zeros -> fails PNG magic-byte check)
function makeNonPngBuffer(totalBytes: number): Buffer {
  return Buffer.alloc(totalBytes);
}

function lambdaResponse(processedBuffer: Buffer, sizeMB = 1, isPng = true) {
  return {
    Payload: Buffer.from(JSON.stringify({ processedBuffer: processedBuffer.toString('base64'), sizeMB, isPng })),
  };
}

describe('invokeImageProcessor', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('fails fast on oversized images without invoking the Lambda', async () => {
    // ~5 MB raw -> base64 payload would exceed the 6 MB sync invocation limit
    const oversized = makeNonPngBuffer(5 * 1024 * 1024);

    await expect(invokeImageProcessor(oversized, LAMBDA_NAME, 4)).rejects.toThrow(/Image too large/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('includes the actual and max sizes in the oversized error message', async () => {
    const oversized = makeNonPngBuffer(5 * 1024 * 1024);

    await expect(invokeImageProcessor(oversized, LAMBDA_NAME, 4)).rejects.toThrow(/5\.00MB.*under 4\.4MB/s);
  });

  it('skips processing for a PNG already under the size limit (fast path)', async () => {
    const smallPng = makePngBuffer(1 * 1024 * 1024); // 1 MB PNG, maxSizeMB 4

    const result = await invokeImageProcessor(smallPng, LAMBDA_NAME, 4);

    expect(result).toBe(smallPng);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('invokes the Lambda for a non-PNG image under the guard threshold', async () => {
    const converted = makePngBuffer(512);
    mockSend.mockResolvedValueOnce(lambdaResponse(converted));

    const jpeg = makeNonPngBuffer(1 * 1024 * 1024); // 1 MB non-PNG → needs conversion
    const result = await invokeImageProcessor(jpeg, LAMBDA_NAME, 4);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.equals(converted)).toBe(true);
  });
});

describe('downloadImageAsBuffer SSRF guard', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    delete process.env.AWS_ENDPOINT_URL_S3;
  });

  it('decodes a data URL without issuing a request', async () => {
    const buf = await downloadImageAsBuffer(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);

    expect(buf.toString()).toBe('png-bytes');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/image.png'],
    ['gopher', 'gopher://example.com/image.png'],
  ])('rejects the %s scheme', async (_label, url) => {
    await expect(downloadImageAsBuffer(url)).rejects.toThrow(/blocked for security reasons/);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it.each([
    ['the link-local metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1/image.png'],
    ['localhost', 'http://localhost:8080/image.png'],
    ['an RFC1918 address', 'http://10.0.0.5/image.png'],
    ['an IPv6 loopback literal', 'http://[::1]/image.png'],
  ])('rejects %s', async (_label, url) => {
    await expect(downloadImageAsBuffer(url)).rejects.toThrow(/blocked for security reasons/);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('never lets axios follow redirects itself', async () => {
    mockAxiosGet.mockResolvedValue({ status: 200, headers: {}, data: Buffer.from('image') });

    await downloadImageAsBuffer(`${PUBLIC_HOST}/image.png`);

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    const config = mockAxiosGet.mock.calls[0][1];
    expect(config.maxRedirects).toBe(0);
    expect(config.proxy).toBe(false);
    expect(config.httpAgent).toBeDefined();
    expect(config.httpsAgent).toBeDefined();
  });

  it('re-validates a redirect hop and rejects one pointing at the metadata endpoint', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      data: Buffer.alloc(0),
    });

    await expect(downloadImageAsBuffer(`${PUBLIC_HOST}/image.png`)).rejects.toThrow(
      /blocked for security reasons/
    );
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to a public host', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ status: 302, headers: { location: '/real.png' }, data: Buffer.alloc(0) })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: Buffer.from('image') });

    const buf = await downloadImageAsBuffer(`${PUBLIC_HOST}/image.png`);

    expect(buf.toString()).toBe('image');
    expect(mockAxiosGet.mock.calls[1][0]).toBe(`${PUBLIC_HOST}/real.png`);
  });

  it('gives up after too many redirects', async () => {
    mockAxiosGet.mockResolvedValue({
      status: 302,
      headers: { location: `${PUBLIC_HOST}/next.png` },
      data: Buffer.alloc(0),
    });

    await expect(downloadImageAsBuffer(`${PUBLIC_HOST}/image.png`)).rejects.toThrow(/Too many redirects/);
  });
});

describe('downloadImageAsBuffer self-host storage endpoint', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
    delete process.env.AWS_ENDPOINT_URL_S3;
  });

  afterEach(() => {
    delete process.env.AWS_ENDPOINT_URL_S3;
  });

  // Self-host resolves the storage host to a compose-network private address, so without the
  // exemption every image-to-image generation would fail the guard.
  it('fetches a signed URL on the configured storage endpoint', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    mockAxiosGet.mockResolvedValue({ status: 200, headers: {}, data: Buffer.from('image') });

    const buf = await downloadImageAsBuffer('http://minio:9000/bucket/key.png?X-Amz-Signature=abc');

    expect(buf.toString()).toBe('image');
    // The pinned agents would refuse the same private address, so they must be omitted here.
    expect(mockAxiosGet.mock.calls[0][1].httpAgent).toBeUndefined();
    expect(mockAxiosGet.mock.calls[0][1].httpsAgent).toBeUndefined();
  });

  it('still blocks a different private host when a storage endpoint is configured', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';

    await expect(downloadImageAsBuffer('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /blocked for security reasons/
    );
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('does not exempt a different port on the same storage host', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';

    await expect(downloadImageAsBuffer('http://minio:9001/bucket/key.png')).rejects.toThrow(
      /blocked for security reasons/
    );
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('re-validates where the storage endpoint redirects to', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    mockAxiosGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      data: Buffer.alloc(0),
    });

    await expect(downloadImageAsBuffer('http://minio:9000/bucket/key.png')).rejects.toThrow(
      /blocked for security reasons/
    );
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });
});
