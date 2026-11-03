// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import ArtifactRenderer from './ArtifactRenderer';
import { getCachedArtifactId } from './ArtifactIdResolver';
import { registerArtifactType } from './registry';
import { getArtifactTimestamp } from '@bike4mind/server-utils/app/utils/artifactParser';
import { findExistingArtifactId } from '@client/app/utils/artifactPersistence';

// The handler registry is populated at module scope by './handlers', which pulls in the
// whole preview-card tree. Register a stub type instead, so this covers the renderer.
vi.mock('./handlers', () => ({}));

vi.mock('@client/app/utils/artifactPersistence', () => ({
  findExistingArtifactId: vi.fn(),
}));
const lookup = vi.mocked(findExistingArtifactId);

registerArtifactType({
  type: 'stub',
  PreviewCard: ({ artifactId, reactGroup }) => (
    <div data-testid="stub-card" data-role={reactGroup?.role}>
      {artifactId}
    </div>
  ),
});

const artifact = { type: 'stub', title: 'Stub', content: 'x', identifier: 'stub-1' };

type CacheWindow = {
  __artifactIdCache?: Map<string, string>;
  __artifactIdLookups?: Map<string, Promise<string | null>>;
  __provisionalArtifactIds?: Map<string, string>;
};
const caches = window as unknown as CacheWindow;

let message = 0;
/** A fresh message id per test, so the per-message timestamp memo never leaks between tests. */
const nextMessageId = () => `msg-${++message}`;
const mintedId = (messageId: string, index: number) =>
  `artifact_stub_stub-1_${getArtifactTimestamp(messageId)}_${index}`;

describe('ArtifactRenderer', () => {
  beforeEach(() => {
    caches.__artifactIdCache = new Map();
    caches.__artifactIdLookups = new Map();
    caches.__provisionalArtifactIds = new Map();
    // Resolution is what the renderer must NOT wait for when the id is already cached; a
    // rejecting default makes an accidental await fail loudly rather than pass slowly.
    lookup.mockReset().mockRejectedValue(new Error('should not be called on a cache hit'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // A virtualized transcript remounts a message every time it scrolls back into view. If
  // the card waits a frame for an id it already has, the item measures at the placeholder's
  // height and then grows, and the list jumps to correct itself.
  it('renders the card on the first frame when the id is already cached', () => {
    caches.__artifactIdCache?.set('session-1_stub_stub-1', 'cached-id');

    render(<ArtifactRenderer artifact={artifact} index={0} messageId="msg-1" sessionId="session-1" />);

    expect(screen.getByTestId('stub-card')).toHaveTextContent('cached-id');
    expect(screen.queryByTestId('artifact-loading')).not.toBeInTheDocument();
  });

  it("hands the artifact's multi-file group role to the handler", () => {
    caches.__artifactIdCache?.set('session-1_stub_stub-1', 'cached-id');

    render(
      <ArtifactRenderer
        artifact={artifact}
        index={0}
        messageId="msg-1"
        sessionId="session-1"
        reactGroup={{ role: 'sibling', entryTitle: 'App' }}
      />
    );

    expect(screen.getByTestId('stub-card')).toHaveAttribute('data-role', 'sibling');
  });

  it('falls back to the loading state when nothing is cached', () => {
    render(<ArtifactRenderer artifact={artifact} index={0} messageId="msg-1" sessionId="session-1" />);

    expect(screen.getByTestId('artifact-loading')).toBeInTheDocument();
  });

  it('keys the cache per session, so one session id never answers for another', () => {
    caches.__artifactIdCache?.set('session-1_stub_stub-1', 'cached-id');

    render(<ArtifactRenderer artifact={artifact} index={0} messageId="msg-1" sessionId="session-2" />);

    expect(screen.getByTestId('artifact-loading')).toBeInTheDocument();
  });

  describe('before the row exists', () => {
    beforeEach(() => {
      lookup.mockReset().mockResolvedValue(null);
    });

    it('does not let an id minted for one index answer for another', async () => {
      // Mid-stream, the first artifact of a reply renders alone at index 0; once a later one
      // arrives the parse renumbers it to 1, which is the index its row is saved under.
      const messageId = nextMessageId();
      const { rerender } = render(
        <ArtifactRenderer artifact={artifact} index={0} messageId={messageId} sessionId="session-1" />
      );
      expect(await screen.findByTestId('stub-card')).toHaveTextContent(mintedId(messageId, 0));

      rerender(<ArtifactRenderer artifact={artifact} index={1} messageId={messageId} sessionId="session-1" />);

      expect(await screen.findByText(mintedId(messageId, 1))).toBeInTheDocument();
      expect(getCachedArtifactId('stub', 'stub-1', 'session-1')).toBeNull();
    });

    it('renders a remount immediately with its minted id while rechecking the database', async () => {
      const messageId = nextMessageId();
      const { unmount } = render(
        <ArtifactRenderer artifact={artifact} index={1} messageId={messageId} sessionId="session-1" />
      );
      await screen.findByTestId('stub-card');
      unmount();

      render(<ArtifactRenderer artifact={artifact} index={1} messageId={messageId} sessionId="session-1" />);

      expect(screen.getByTestId('stub-card')).toHaveTextContent(mintedId(messageId, 1));
      await act(async () => {});
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("adopts the saved row once its reply's artifacts are persisted", async () => {
      const messageId = nextMessageId();
      render(<ArtifactRenderer artifact={artifact} index={0} messageId={messageId} sessionId="session-1" />);
      await screen.findByText(mintedId(messageId, 0));

      lookup.mockResolvedValue('artifact_stub_stub-1_saved_3');
      act(() => {
        window.dispatchEvent(new CustomEvent('artifacts-persisted', { detail: { questId: 'other-message' } }));
      });
      expect(lookup).toHaveBeenCalledTimes(1);

      act(() => {
        window.dispatchEvent(new CustomEvent('artifacts-persisted', { detail: { questId: messageId } }));
      });

      expect(await screen.findByText('artifact_stub_stub-1_saved_3')).toBeInTheDocument();
      expect(getCachedArtifactId('stub', 'stub-1', 'session-1')).toBe('artifact_stub_stub-1_saved_3');
    });

    it('rechecks a provisional id when persistence completed while its card was unmounted', async () => {
      const messageId = nextMessageId();
      const { unmount } = render(
        <ArtifactRenderer artifact={artifact} index={0} messageId={messageId} sessionId="session-1" />
      );
      await screen.findByText(mintedId(messageId, 0));
      unmount();

      lookup.mockResolvedValue('artifact_stub_stub-1_saved_3');
      act(() => {
        window.dispatchEvent(new CustomEvent('artifacts-persisted', { detail: { questId: messageId } }));
      });

      render(<ArtifactRenderer artifact={artifact} index={0} messageId={messageId} sessionId="session-1" />);

      expect(screen.getByTestId('stub-card')).toHaveTextContent(mintedId(messageId, 0));
      expect(screen.queryByTestId('artifact-loading')).not.toBeInTheDocument();
      expect(await screen.findByText('artifact_stub_stub-1_saved_3')).toBeInTheDocument();
      expect(lookup).toHaveBeenCalledTimes(2);
    });
  });
});
