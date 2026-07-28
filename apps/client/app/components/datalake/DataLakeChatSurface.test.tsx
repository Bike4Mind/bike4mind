import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import DataLakeChatSurface from './DataLakeChatSurface';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: 's1', forceKnowledgeRetrieval: false } }),
}));
// Stub the heavy explorer so the test asserts only the conditional wrapping + the
// chat-embedded contract (file clicks may own the layout only when the chat is inside).
vi.mock('./DataLakeExplorer', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
  default: ({ chatSlot, chatEmbedded }: any) => (
    <div data-testid="explorer" data-chat-embedded={String(!!chatEmbedded)}>
      {chatSlot}
    </div>
  ),
}));

describe('DataLakeChatSurface', () => {
  beforeEach(() => {
    useDataLakeMode.setState({ enabled: false, seededSessionId: 's1' });
  });

  it('renders the bare chat when mode is off', () => {
    render(<DataLakeChatSurface chat={<div data-testid="chat" />} />);
    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.queryByTestId('explorer')).toBeNull();
  });

  it('wraps the chat in the explorer when mode is on', () => {
    useDataLakeMode.setState({ enabled: true, seededSessionId: 's1' });
    render(<DataLakeChatSurface chat={<div data-testid="chat" />} />);
    const explorer = screen.getByTestId('explorer');
    expect(explorer).toBeInTheDocument();
    expect(explorer).toContainElement(screen.getByTestId('chat'));
    // The chat lives IN the explorer here, so file clicks may drive the KnowledgeViewer layout.
    expect(explorer).toHaveAttribute('data-chat-embedded', 'true');
  });
});
