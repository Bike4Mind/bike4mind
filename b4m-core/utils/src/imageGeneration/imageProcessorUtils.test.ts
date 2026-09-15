import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock for the Lambda client's send method so we can assert on calls.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { invokeImageProcessor } from './imageProcessorUtils';

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
