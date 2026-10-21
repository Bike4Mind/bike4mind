import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatArtifact } from '@shared/chat';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPublisher } from './ArtifactPublisher';

function artifact(overrides: Partial<ChatArtifact> = {}): ChatArtifact {
  return {
    id: 'artifact-1',
    identifier: 'hello',
    type: 'html',
    mimeType: 'text/html',
    title: 'Hello Page',
    content: '<h1>Hi</h1>',
    ...overrides,
  };
}

/** An axios rejection as the publisher sees it: `isAxiosError` keys on the flag, not the class. */
function httpError(status: number): AxiosError {
  const error = new AxiosError('request failed');
  error.response = { status } as AxiosError['response'];
  return error;
}

describe('ArtifactPublisher', () => {
  let post: ReturnType<typeof vi.fn>;
  let apiClient: AuthenticatedApiClient | null;
  let publisher: ArtifactPublisher;

  beforeEach(() => {
    post = vi.fn().mockResolvedValue({ status: 201, data: {} });
    apiClient = { getAxiosInstance: () => ({ post }) } as unknown as AuthenticatedApiClient;
    publisher = new ArtifactPublisher(() => apiClient, { debug: vi.fn() });
  });

  it('posts nothing for an empty list', async () => {
    expect(await publisher.publish([], 'session-1')).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts each artifact of a multi-artifact turn and marks them saved', async () => {
    const saved = await publisher.publish(
      [artifact({ id: 'a' }), artifact({ id: 'b', type: 'svg', mimeType: 'image/svg+xml' })],
      'session-1'
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(saved.map(a => a.save)).toEqual([{ status: 'saved' }, { status: 'saved' }]);
  });

  it('sends the fields the create route keys on', async () => {
    await publisher.publish([artifact()], 'session-1');

    const [endpoint, payload] = post.mock.calls[0];
    expect(endpoint).toBe('/api/artifacts');
    expect(payload).toMatchObject({
      id: 'artifact-1',
      type: 'html',
      title: 'Hello Page',
      content: '<h1>Hi</h1>',
      visibility: 'private',
      // aiGenerated is what subjects the row to the user's artifact opt-out server-side.
      metadata: { aiGenerated: true, createdFrom: 'desktop', desktopSessionId: 'session-1' },
    });
  });

  it('never sends sessionId, which the route reads as a SERVER session id', async () => {
    // assertArtifactSourceRefsAccessible 403s the whole create when the caller has no update
    // access to the referenced session, and a desktop session id names no server row at all.
    await publisher.publish([artifact()], 'local-session-42');

    expect(post.mock.calls[0][1]).not.toHaveProperty('sessionId');
    expect(post.mock.calls[0][1].metadata.desktopSessionId).toBe('local-session-42');
  });

  it('reads a 403 as the artifact opt-out rather than a failure', async () => {
    post.mockRejectedValue(httpError(403));

    const [result] = await publisher.publish([artifact()], 'session-1');
    expect(result.save).toEqual({ status: 'disabled', reason: 'Artifacts are turned off for your account.' });
  });

  it('reports a server failure without losing the artifact', async () => {
    post.mockRejectedValue(httpError(500));

    const [result] = await publisher.publish([artifact()], 'session-1');
    expect(result.save).toMatchObject({ status: 'failed' });
    expect(result.content).toBe('<h1>Hi</h1>');
  });

  it('reports being signed out instead of throwing', async () => {
    apiClient = null;

    const [result] = await publisher.publish([artifact()], 'session-1');
    expect(result.save).toEqual({ status: 'failed', reason: 'Not signed in.' });
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses an artifact too large for the route before spending a request on it', async () => {
    const [result] = await publisher.publish([artifact({ content: 'x'.repeat(2_000_001) })], 'session-1');

    expect(post).not.toHaveBeenCalled();
    expect(result.save).toMatchObject({ status: 'failed' });
  });

  it('saves what it can when one artifact of several is rejected', async () => {
    post.mockResolvedValueOnce({ status: 201, data: {} }).mockRejectedValueOnce(httpError(500));

    const saved = await publisher.publish([artifact({ id: 'a' }), artifact({ id: 'b' })], 'session-1');
    expect(saved.map(a => a.save?.status)).toEqual(['saved', 'failed']);
  });
});
