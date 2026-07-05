import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockS3Send = vi.hoisted(() => vi.fn());
const mockValidateTargetUrl = vi.hoisted(() => vi.fn());

vi.mock('sst', () => ({
  Resource: {
    appFilesBucket: { name: 'test-bucket' },
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(...args: unknown[]) {
      return mockS3Send(...args);
    }
  },
  PutObjectCommand: class {},
  HeadObjectCommand: class {},
}));

vi.mock('./ssrfProtection', () => ({
  validateTargetUrl: (...args: unknown[]) => mockValidateTargetUrl(...args),
}));

import { cacheExternalImage } from './cacheExternalImage';

describe('cacheExternalImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SSRF protection', () => {
    it('blocks SSRF URLs and returns original URL without calling S3', async () => {
      const ssrfUrl = 'http://169.254.169.254/latest/meta-data/';
      mockValidateTargetUrl.mockResolvedValue({
        valid: false,
        error: 'URL points to a private or internal network',
      });

      const result = await cacheExternalImage(ssrfUrl);

      expect(result).toBe(ssrfUrl);
      expect(mockValidateTargetUrl).toHaveBeenCalledWith(ssrfUrl);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('blocks localhost URLs and returns original URL without calling S3', async () => {
      const localhostUrl = 'http://localhost:3000/secret';
      mockValidateTargetUrl.mockResolvedValue({
        valid: false,
        error: 'URL points to a private or internal network',
      });

      const result = await cacheExternalImage(localhostUrl);

      expect(result).toBe(localhostUrl);
      expect(mockValidateTargetUrl).toHaveBeenCalledWith(localhostUrl);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('allows valid external URLs through to S3 caching', async () => {
      const validUrl = 'https://example.com/image.png';
      mockValidateTargetUrl.mockResolvedValue({ valid: true });
      // Simulate image already cached in S3
      mockS3Send.mockResolvedValueOnce({});

      const result = await cacheExternalImage(validUrl);

      expect(mockValidateTargetUrl).toHaveBeenCalledWith(validUrl);
      expect(mockS3Send).toHaveBeenCalled();
      expect(result).not.toBe(validUrl);
    });
  });

  describe('transient fetch error retry', () => {
    const validUrl = 'https://example.com/image.png';

    const makeTransientError = () => {
      const err = new Error('terminated');
      (err as NodeJS.ErrnoException).cause = { code: 'UND_ERR_SOCKET' } as unknown as Error;
      return err;
    };

    beforeEach(() => {
      mockValidateTargetUrl.mockResolvedValue({ valid: true });
      // HEAD miss -> fall through to the download (fetch) path
      mockS3Send.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'HeadObjectCommand') {
          return Promise.reject(Object.assign(new Error('not found'), { name: 'NotFound' }));
        }
        return Promise.resolve({}); // PutObjectCommand
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('retries on a transient socket error then succeeds', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(makeTransientError())
        .mockResolvedValueOnce(
          new Response(new ArrayBuffer(8), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          })
        );
      vi.stubGlobal('fetch', fetchMock);
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const promise = cacheExternalImage(validUrl);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).not.toBe(validUrl); // cached → S3 URL
      // observability: a success-after-retry log closes the "did the retry save us?" loop
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('after 1 retry'));

      infoSpy.mockRestore();
    });

    it('gives up after exhausting retries and degrades to the original URL', async () => {
      const fetchMock = vi.fn().mockRejectedValue(makeTransientError());
      vi.stubGlobal('fetch', fetchMock);

      const promise = cacheExternalImage(validUrl);
      await vi.runAllTimersAsync();
      const result = await promise;

      // initial attempt + MAX_FETCH_RETRIES (2) = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toBe(validUrl);
    });

    it('does not retry on a non-transient error', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('some other failure'));
      vi.stubGlobal('fetch', fetchMock);

      const promise = cacheExternalImage(validUrl);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toBe(validUrl);
    });

    it('does not retry the per-attempt timeout (AbortError) and degrades to the original URL', async () => {
      // The shared isRetryableError matches 'aborted'/'timeout' message patterns, so the custom
      // isRetryable must exclude AbortError - otherwise withRetry would keep racing a slow
      // upstream. A fetch timeout is NOT retried.
      const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      const fetchMock = vi.fn().mockRejectedValue(abortError);
      vi.stubGlobal('fetch', fetchMock);

      const promise = cacheExternalImage(validUrl);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toBe(validUrl);
    });
  });

  describe('early returns (skip SSRF check)', () => {
    it('skips SSRF check for S3 URLs', async () => {
      const s3Url = 'https://my-bucket.s3.amazonaws.com/image.png';

      const result = await cacheExternalImage(s3Url);

      expect(result).toBe(s3Url);
      expect(mockValidateTargetUrl).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('skips SSRF check for non-HTTP URLs', async () => {
      const dataUrl = 'data:image/png;base64,abc123';

      const result = await cacheExternalImage(dataUrl);

      expect(result).toBe(dataUrl);
      expect(mockValidateTargetUrl).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });
});
