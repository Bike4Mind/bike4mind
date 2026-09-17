// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ArtifactRenderer from './ArtifactRenderer';
import { registerArtifactType } from './registry';

// The handler registry is populated at module scope by './handlers', which pulls in the
// whole preview-card tree. Register a stub type instead, so this covers the renderer.
vi.mock('./handlers', () => ({}));

// Resolution is what the renderer must NOT wait for when the id is already cached; a
// rejecting stub makes an accidental await fail loudly rather than pass slowly.
vi.mock('@client/app/utils/artifactPersistence', () => ({
  findExistingArtifactId: vi.fn().mockRejectedValue(new Error('should not be called on a cache hit')),
}));

registerArtifactType({
  type: 'stub',
  PreviewCard: ({ artifactId }) => <div data-testid="stub-card">{artifactId}</div>,
});

const artifact = { type: 'stub', title: 'Stub', content: 'x', identifier: 'stub-1' };

describe('ArtifactRenderer', () => {
  beforeEach(() => {
    (window as unknown as { __artifactIdCache?: Map<string, string> }).__artifactIdCache = new Map();
  });

  // A virtualized transcript remounts a message every time it scrolls back into view. If
  // the card waits a frame for an id it already has, the item measures at the placeholder's
  // height and then grows, and the list jumps to correct itself.
  it('renders the card on the first frame when the id is already cached', () => {
    (window as unknown as { __artifactIdCache: Map<string, string> }).__artifactIdCache.set(
      'session-1_stub_stub-1',
      'cached-id'
    );

    render(<ArtifactRenderer artifact={artifact} index={0} messageId="msg-1" sessionId="session-1" />);

    expect(screen.getByTestId('stub-card')).toHaveTextContent('cached-id');
    expect(screen.queryByTestId('artifact-loading')).not.toBeInTheDocument();
  });

  it('falls back to the loading state when nothing is cached', () => {
    render(<ArtifactRenderer artifact={artifact} index={0} messageId="msg-1" sessionId="session-1" />);

    expect(screen.getByTestId('artifact-loading')).toBeInTheDocument();
  });

  it('keys the cache per session, so one session id never answers for another', () => {
    (window as unknown as { __artifactIdCache: Map<string, string> }).__artifactIdCache.set(
      'session-1_stub_stub-1',
      'cached-id'
    );

    render(<ArtifactRenderer artifact={artifact} index={0} messageId="msg-1" sessionId="session-2" />);

    expect(screen.getByTestId('artifact-loading')).toBeInTheDocument();
  });
});
