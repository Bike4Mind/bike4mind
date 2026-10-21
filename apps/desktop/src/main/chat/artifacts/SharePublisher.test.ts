import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatArtifactPublishProgress, ChatArtifactPublishRequest } from '@shared/chat';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SharePublisher, toArtifactType, toSlug } from './SharePublisher';

const BASE_URL = 'https://example.test';
const DRAFT_ID = '11111111-2222-4333-8444-555555555555';

function request(overrides: Partial<ChatArtifactPublishRequest> = {}): ChatArtifactPublishRequest {
  return {
    artifactId: 'abc123def456',
    type: 'html',
    title: 'Hello Page',
    content: '<h1>Hi</h1>',
    visibility: 'private',
    ...overrides,
  };
}

/** An axios rejection as the publisher sees it: `isAxiosError` keys on the flag, not the class. */
function httpError(status: number, data?: unknown): AxiosError {
  const error = new AxiosError('request failed');
  error.response = { status, data } as AxiosError['response'];
  return error;
}

describe('SharePublisher', () => {
  let post: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;
  let userId: string | undefined;
  let progress: ChatArtifactPublishProgress[];
  let publisher: SharePublisher;

  beforeEach(() => {
    progress = [];
    userId = 'user-1';
    post = vi.fn(async (url: string) =>
      url.endsWith('/upload-url')
        ? {
            data: {
              draftId: DRAFT_ID,
              uploadUrls: [{ path: 'index.html', url: 'https://bucket.test/put', expiresAt: 'later' }],
            },
          }
        : {
            data: {
              publicId: 'pub-1',
              url: '/p/u/user-1/hello-page-abc123',
              tier: 'user',
              scopeId: 'user-1',
              slug: 'hello-page-abc123',
              visibility: 'private',
              publishedAt: '2026-01-01T00:00:00.000Z',
            },
          }
    );
    get = vi.fn().mockResolvedValue({ data: { artifacts: [] } });
    apiClient = {
      getAxiosInstance: () => ({ post, get, defaults: { baseURL: BASE_URL } }),
    } as unknown as AuthenticatedApiClient;

    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    publisher = new SharePublisher(
      () => apiClient,
      () => userId,
      { debug: vi.fn() },
      event => progress.push(event)
    );
  });

  it('runs all three steps in order and reports where it got to', async () => {
    const result = await publisher.publish(request());

    expect(post.mock.calls[0][0]).toBe('/api/publish/artifact/upload-url');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[1][0]).toBe('/api/publish/artifact/finalize');
    expect(post.mock.calls[1][1]).toEqual({ draftId: DRAFT_ID });

    expect(progress.map(p => p.step)).toEqual(['requesting', 'uploading', 'finalizing', 'done']);
    expect(result).toMatchObject({
      status: 'published',
      url: `${BASE_URL}/p/u/user-1/hello-page-abc123`,
      visibility: 'private',
    });
  });

  it('uploads RAW content and names the artifact type, so finalize renders the page', async () => {
    await publisher.publish(request({ type: 'mermaid', content: 'graph TD;A-->B;' }));

    const [, body] = post.mock.calls[0];
    expect(body.source).toEqual({ kind: 'bundle', artifactId: 'abc123def456', artifactType: 'mermaid' });
    expect(body.files).toEqual([{ path: 'index.html', size: 15, mimeType: 'text/html' }]);
    expect(fetchMock.mock.calls[0][1].body).toBe('graph TD;A-->B;');
  });

  it('publishes under the signed-in account at the user tier', async () => {
    await publisher.publish(request({ visibility: 'public' }));

    expect(post.mock.calls[0][1]).toMatchObject({ tier: 'user', scopeId: 'user-1', visibility: 'public' });
  });

  it('PUTs to the URL step 1 handed back, with no app auth header', async () => {
    await publisher.publish(request());

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://bucket.test/put');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'text/html' });
    expect(Object.keys(init)).not.toContain('auth');
  });

  it('resolves a same-origin upload path against the server, as a browser would', async () => {
    post.mockImplementationOnce(async () => ({
      data: {
        draftId: DRAFT_ID,
        uploadUrls: [{ path: 'index.html', url: '/api/publish/artifact/draft-upload?token=t', expiresAt: 'later' }],
      },
    }));

    await publisher.publish(request());

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE_URL}/api/publish/artifact/draft-upload?token=t`);
  });

  it('refuses an oversized artifact before uploading anything', async () => {
    const result = await publisher.publish(request({ content: 'x'.repeat(11 * 1024 * 1024) }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('over the');
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a 422 structured, because the violations are what say what to fix', async () => {
    post.mockImplementation(async (url: string) => {
      if (url.endsWith('/upload-url')) {
        return {
          data: {
            draftId: DRAFT_ID,
            uploadUrls: [{ path: 'index.html', url: 'https://bucket.test/put', expiresAt: 'later' }],
          },
        };
      }
      throw httpError(422, {
        error: 'Validation failed',
        violations: [{ type: 'forbidden_pattern', message: 'Inline script is not allowed', file: 'index.html' }],
      });
    });

    const result = await publisher.publish(request());

    expect(result.status).toBe('rejected');
    expect(result.violations).toEqual([
      { type: 'forbidden_pattern', message: 'Inline script is not allowed', file: 'index.html' },
    ]);
  });

  it('reads a quota refusal as a limit rather than a fault', async () => {
    post.mockImplementationOnce(async () => {
      throw httpError(413, { error: 'Published-artifact limit reached', code: 'publish_quota_artifacts' });
    });

    const result = await publisher.publish(request());

    expect(result.status).toBe('quota');
    expect(result.reason).toBe('Published-artifact limit reached');
  });

  it('says the outcome is UNKNOWN when finalize never answered', async () => {
    post.mockImplementation(async (url: string) => {
      if (url.endsWith('/upload-url')) {
        return {
          data: {
            draftId: DRAFT_ID,
            uploadUrls: [{ path: 'index.html', url: 'https://bucket.test/put', expiresAt: 'later' }],
          },
        };
      }
      throw new AxiosError('socket hang up');
    });

    const result = await publisher.publish(request());

    // The draft may already have been promoted, so neither "published" nor "not published" is
    // a claim this client can make about who can reach the content.
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('may or may not be reachable');
  });

  it('does not reach the network when signed out', async () => {
    apiClient = null;

    const result = await publisher.publish(request());

    expect(result).toEqual({ status: 'failed', reason: 'Sign in to publish.' });
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never finalizes a draft whose bytes did not upload', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const result = await publisher.publish(request());

    expect(result.status).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
  });

  describe('readState', () => {
    it('asks for one artifact, not for a list', async () => {
      get.mockResolvedValue({
        data: {
          artifacts: [
            { tier: 'user', scopeId: 'user-1', slug: 'hello-page-abc123', visibility: 'public', publishedAt: 'then' },
          ],
        },
      });

      const state = await publisher.readState('abc123def456');

      expect(get.mock.calls[0][1].params).toMatchObject({ sourceArtifactId: 'abc123def456', limit: 1 });
      expect(state).toEqual({
        status: 'published',
        url: `${BASE_URL}/p/u/user-1/hello-page-abc123`,
        visibility: 'public',
        publishedAt: 'then',
      });
    });

    it('answers null for an artifact that was never published', async () => {
      expect(await publisher.readState('abc123def456')).toBeNull();
    });

    it('says unknown rather than "not published" when the read failed', async () => {
      get.mockRejectedValue(httpError(500));

      expect(await publisher.readState('abc123def456')).toMatchObject({ status: 'unknown' });
    });
  });
});

describe('toSlug', () => {
  it('builds a lowercase kebab slug the server will accept', () => {
    expect(toSlug('Hello, World!', 'abc123def456')).toBe('hello-world-abc123');
  });

  it('still reaches the minimum length when the title slugifies to nothing', () => {
    expect(toSlug('!!!', 'abc123def456')).toBe('artifact-abc123');
  });

  it('never leaves a trailing dash after truncating a long title', () => {
    const slug = toSlug(`${'a'.repeat(48)} tail`, 'abc123def456');
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(slug.length).toBeLessThanOrEqual(64);
  });

  it('keeps a non-hex id distinguishing, rather than collapsing it to a shared fallback', () => {
    expect(toSlug('Report', 'A_B/C-D')).toBe('report-abcd');
  });

  it('falls back only when the id contributes no usable characters at all', () => {
    expect(toSlug('Report', '___')).toBe('report-shared');
  });
});

describe('toArtifactType', () => {
  it('passes a known type through', () => {
    expect(toArtifactType('react')).toBe('react');
  });

  it('falls back to code, which is the page an unknown type would render anyway', () => {
    expect(toArtifactType('totally-made-up')).toBe('code');
  });
});
