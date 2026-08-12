import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import DataLakeChatSurface from './DataLakeChatSurface';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: 's1', forceKnowledgeRetrieval: false } }),
}));
// The shared manage-knowledge gate reads the admin settings cache and the user store.
const isAdminFeatureEnabled = vi.fn(() => true);
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled, isFeatureEnabled: vi.fn(), isLoading: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { isAdmin: boolean }) => unknown) =>
    selector ? selector({ isAdmin: false }) : { isAdmin: false },
}));
// The surface wires useCreateDataLakeSession into the explorer's file-click-on-/new path;
// stub it so this test needs no router/query providers.
vi.mock('@client/app/hooks/useCreateDataLakeSession', () => ({
  default: () => async () => ({ id: 'sess-new' }),
}));
// Stub the heavy explorer so the test asserts only the conditional wrapping, the chat-embedded
// contract (View may own the layout only when the chat is inside), and the create-session wiring.
vi.mock('./DataLakeExplorer', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
  default: ({ chatSlot, chatEmbedded, createSessionForFile, onManage }: any) => (
    <div
      data-testid="explorer"
      data-chat-embedded={String(!!chatEmbedded)}
      data-can-create-session={String(typeof createSessionForFile === 'function')}
      data-can-manage={String(typeof onManage === 'function')}
      onClick={onManage}
    >
      {chatSlot}
    </div>
  ),
}));

describe('DataLakeChatSurface', () => {
  beforeEach(() => {
    useDataLakeMode.setState({ enabled: false, seededSessionId: 's1' });
    useDataLakeWizardStore.setState({ isManagerOpen: false, managerTab: 'mine' });
    isAdminFeatureEnabled.mockReturnValue(true);
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
    // /new attach clicks can mint the grounded session instead of dead-ending.
    expect(explorer).toHaveAttribute('data-can-create-session', 'true');
    // The chat lives IN the explorer here, so View may drive the KnowledgeViewer layout.
    expect(explorer).toHaveAttribute('data-chat-embedded', 'true');
  });

  it('hands down a bare-calling manage handler, so a click event never lands on the tab arg', () => {
    useDataLakeMode.setState({ enabled: true, seededSessionId: 's1' });
    render(<DataLakeChatSurface chat={<div data-testid="chat" />} />);

    // Passing the store's `openManager` straight through made the click event the optional
    // `tab` argument, parking a synthetic event in the store where a ManagerTab belongs.
    fireEvent.click(screen.getByTestId('explorer'));

    expect(useDataLakeWizardStore.getState().isManagerOpen).toBe(true);
    expect(useDataLakeWizardStore.getState().managerTab).toBe('mine');
  });

  it('withholds the manage handler when EnableDataLakes is off, since every manage request 403s', () => {
    isAdminFeatureEnabled.mockReturnValue(false);
    useDataLakeMode.setState({ enabled: true, seededSessionId: 's1' });
    render(<DataLakeChatSurface chat={<div data-testid="chat" />} />);

    // Undefined rather than a no-op: the tree hides its Manage button when unset.
    expect(screen.getByTestId('explorer')).toHaveAttribute('data-can-manage', 'false');
  });
});
