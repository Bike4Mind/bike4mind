import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * Gating coverage for the per-reply "Send to Data Lake" menu item: it must be
 * hidden when EnableDataLakes is off (otherwise it opens the app-level modal
 * into a dead-end empty state), and stay functional when the feature is on.
 *
 * MessageContent is a heavy component; everything around the actions menu is
 * mocked to a stub so the test exercises only the real menu markup.
 */

const mocks = vi.hoisted(() => ({
  showCreditsUsed: true,
  serverSettings: [] as Array<{ settingName: string; settingValue: unknown }>,
  sessionFeedback: [] as Array<{ questId?: string }>,
}));

// --- context / data hooks -------------------------------------------------
vi.mock('@client/app/contexts/UserContext', () => ({
  // organizationId is the org the server (checkScopePermission) will accept a Team publish for;
  // the Team option is gated on the selected org matching it.
  useUser: () => ({ currentUser: { id: 'user-1', organizationId: 'org_42', showCreditsUsed: mocks.showCreditsUsed } }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn() }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/contexts/LLMContext', () => {
  const state = { researchMode: { enabled: false }, setLLM: vi.fn() };
  return { useLLM: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: vi.fn(() => vi.fn()) }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useForkSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSnipSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/quests', () => ({
  useGetQuest: () => ({ data: undefined, isLoading: false }),
  useUpdateQuest: () => Object.assign(vi.fn(), { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFilesByQuestId: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/data/feedback', () => ({
  useGetFeedbackBySessionId: () => ({ data: mocks.sessionFeedback }),
  feedbackSessionQueryKey: (sessionId: string, userId: string | undefined) => [
    'feedback',
    'session',
    sessionId,
    userId,
  ],
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: mocks.serverSettings }),
}));
// Capturable across renders so the share-wiring tests can assert the exact options
// handleShareReply passes (esp. whether orgOption is supplied).
const publishAndShareSpy = vi.fn();
vi.mock('@client/app/hooks/usePublishShare', () => ({
  usePublishShare: () => ({ publishAndShare: publishAndShareSpy, modal: null }),
}));
vi.mock('@client/app/hooks/useMessageEditMode', () => {
  const state = { triggerEdit: vi.fn() };
  return { useMessageEditMode: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/components/Session/PromptMetaInspector', () => {
  const state = { setPromptMeta: vi.fn() };
  return { usePromptMetaInspector: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/hooks/useSubscribeChatCompletion', () => ({
  useSubscribeChatCompletion: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

// --- utils with API/server dependencies ------------------------------------
vi.mock('@client/app/utils/fabFileUtils', () => ({
  saveToFileAndWorkbench: vi.fn(),
}));
vi.mock('@client/app/utils/publishApi', () => ({
  replyPublisher: vi.fn(() => vi.fn()),
}));
// Mutable so a test can flip between personal (null) and an active org account.
let selectedAccountValue: { id: string; name: string; personal: boolean } | null = null;
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: typeof selectedAccountValue }) => unknown) =>
    selector({ selectedAccount: selectedAccountValue }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// --- heavy child components (not under test) --------------------------------
vi.mock('@client/app/components/Session/PromptReplies', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/UserPrompt', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/CopyTextButton', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/ToolsUsed', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AgentExecution/ReasoningDisclosure', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AgentExecution/AutoRouteBadge', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/ResearchModeResponseDisplay', () => ({ default: () => null }));
vi.mock('@client/app/components/ConfirmActionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/BugReportModal', () => ({
  default: ({
    open,
    sessionId,
    questId,
    onSubmitted,
  }: {
    open: boolean;
    sessionId?: string;
    questId?: string;
    onSubmitted?: () => void;
  }) =>
    open ? (
      <div data-testid="bug-report-modal-mock" data-session-id={sessionId} data-quest-id={questId}>
        <button data-testid="bug-report-modal-mock-submit" onClick={onSubmitted}>
          submit
        </button>
      </div>
    ) : null,
}));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn() }));

// --- the flag under test ----------------------------------------------------
// Default (flag on) is established in beforeEach; tests override per-case.
const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';
import { replyPublisher } from '@client/app/utils/publishApi';
import MessageContent from './MessageContent';

const replyPublisherMock = replyPublisher as unknown as ReturnType<typeof vi.fn>;

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children, queryClient }: { children: ReactNode; queryClient?: QueryClient }) => (
  <QueryClientProvider client={queryClient ?? new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const messageData = {
  id: 'quest-1',
  prompt: 'hello',
  replies: ['a reply worth saving'],
  status: 'done',
} as unknown as IChatHistoryItem;

// Accepts an explicit queryClient so a test can spy on it (e.g. asserting invalidateQueries is
// called with the right key) rather than only observing DOM effects.
function renderMessageContent(data: IChatHistoryItem = messageData, queryClient?: QueryClient) {
  render(
    <TestWrapper queryClient={queryClient}>
      <MessageContent
        sessionId="session-1"
        messageData={data}
        index={0}
        onDelete={vi.fn()}
        onPinToggle={vi.fn()}
        onSendMessage={vi.fn()}
        isLastMessage={false}
        model="gpt-4o"
        totalMessages={1}
        canUseAdminTools={false}
      />
    </TestWrapper>
  );
}

function renderAndOpenActionsMenu() {
  renderMessageContent();
  fireEvent.click(screen.getByTestId('message-actions-menu-btn'));
}

// Publish-and-share is a top-level button in the action bar, not a menu item, so
// no dropdown has to be opened first.
function renderAndClickPublishShare(data: IChatHistoryItem = messageData) {
  renderMessageContent(data);
  fireEvent.click(screen.getByTestId('message-publish-share-btn'));
}

beforeEach(() => {
  mocks.showCreditsUsed = true;
  mocks.serverSettings = [];
  mocks.sessionFeedback = [];
});

describe('MessageContent actions menu - EnableDataLakes gating', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    useSendToDataLakeStore.setState({ isOpen: false });
  });

  it('shows the Send to Data Lake item when the feature is on', () => {
    renderAndOpenActionsMenu();

    expect(screen.getByTestId('message-send-to-datalake')).toBeInTheDocument();
  });

  it('hides the Send to Data Lake item when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenActionsMenu();

    expect(screen.queryByTestId('message-send-to-datalake')).not.toBeInTheDocument();
  });

  it('keeps the neighboring actions available when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenActionsMenu();

    // Delete sits right after the gated item; the items above it must survive too.
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Toggle Code View')).toBeInTheDocument();
    expect(screen.getByText(/^Save as/)).toBeInTheDocument();
  });

  it('still opens the Send to Data Lake modal from the item when the feature is on', () => {
    renderAndOpenActionsMenu();

    fireEvent.click(screen.getByTestId('message-send-to-datalake'));

    expect(useSendToDataLakeStore.getState().isOpen).toBe(true);
  });
});

describe('MessageContent share reply - org (Team) visibility wiring', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    publishAndShareSpy.mockReset();
    replyPublisherMock.mockReset();
    replyPublisherMock.mockReturnValue(vi.fn());
    selectedAccountValue = null;
  });

  it('offers the Team option and publishes org-scoped when an org account is active', async () => {
    selectedAccountValue = { id: 'org_42', name: 'Acme', personal: false };
    renderAndClickPublishShare();

    await waitFor(() => expect(publishAndShareSpy).toHaveBeenCalledTimes(1));
    // The dialog is told to offer Team, and the publisher is built with the org id so a Team
    // pick lands an org-tier page.
    expect(publishAndShareSpy.mock.calls[0][0]).toMatchObject({
      orgOption: { label: 'Team', hint: 'Members of Acme' },
    });
    expect(replyPublisherMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_42' }));
  });

  it('omits the Team option in a personal account context', async () => {
    selectedAccountValue = null;
    renderAndClickPublishShare();

    await waitFor(() => expect(publishAndShareSpy).toHaveBeenCalledTimes(1));
    expect(publishAndShareSpy.mock.calls[0][0].orgOption).toBeUndefined();
    expect(replyPublisherMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: undefined }));
  });

  it("omits Team when the selected org is NOT the user's publishable org (multi-org member)", async () => {
    // The account switcher lists every org the user belongs to, but checkScopePermission only
    // accepts a Team publish for user.organizationId. Selecting a different (still valid) org must
    // not offer Team, or the publish would 403.
    selectedAccountValue = { id: 'org_OTHER', name: 'Other Org', personal: false };
    renderAndClickPublishShare();

    await waitFor(() => expect(publishAndShareSpy).toHaveBeenCalledTimes(1));
    expect(publishAndShareSpy.mock.calls[0][0].orgOption).toBeUndefined();
    expect(replyPublisherMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: undefined }));
  });
});

describe('MessageContent publish-and-share - visible action-bar button', () => {
  // The action used to be buried in the "More options" dropdown and users never found it.
  // It now sits in the always-visible action bar, and must NOT also be in the menu.
  const emptyReplyMessageData = {
    id: 'quest-2',
    prompt: 'hello',
    replies: [],
    status: 'done',
  } as unknown as IChatHistoryItem;

  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    publishAndShareSpy.mockReset();
    replyPublisherMock.mockReset();
    replyPublisherMock.mockReturnValue(vi.fn());
    selectedAccountValue = null;
  });

  it('renders the button without opening any menu', () => {
    renderMessageContent();

    const button = screen.getByTestId('message-publish-share-btn');
    expect(button).toBeInTheDocument();
    // Icon-only, so the accessible name is what carries the label.
    expect(button).toHaveAccessibleName('Publish & Share');
  });

  it('hides the button when the reply has no shareable content', () => {
    renderMessageContent(emptyReplyMessageData);

    expect(screen.queryByTestId('message-publish-share-btn')).not.toBeInTheDocument();
  });

  it('invokes the share flow on click', async () => {
    renderAndClickPublishShare();

    await waitFor(() => expect(publishAndShareSpy).toHaveBeenCalledTimes(1));
    expect(replyPublisherMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: 'quest-1' })
    );
  });

  it('no longer duplicates the action inside the More options menu', () => {
    renderAndOpenActionsMenu();

    expect(screen.queryByTestId('message-share-reply')).not.toBeInTheDocument();
  });

  // The action bar is duplicated for the narrow layout, so the mobile copy needs its own
  // coverage - the desktop assertions above cannot catch a miss there.
  describe('mobile action bar', () => {
    const desktopWidth = window.innerWidth;

    beforeEach(() => {
      // MessageContent reads window.innerWidth on mount to pick the layout.
      Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true, writable: true });
    });

    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: desktopWidth, configurable: true, writable: true });
    });

    it('renders the icon button and wires it to the share flow', async () => {
      renderAndClickPublishShare();

      expect(document.querySelector('.action-buttons-mobile')).not.toBeNull();
      await waitFor(() => expect(publishAndShareSpy).toHaveBeenCalledTimes(1));
    });

    it('hides the icon button when the reply has no shareable content', () => {
      renderMessageContent(emptyReplyMessageData);

      expect(screen.queryByTestId('message-publish-share-btn')).not.toBeInTheDocument();
    });
  });
});

describe('MessageContent report action - persistent affordance (#1869)', () => {
  // The control used to be buried in the "More options" dropdown (see the issue's own
  // description of it going unfound there). It now sits in the always-visible action bar, and
  // must NOT also be in the menu.
  it('renders the persistent Report button without opening any menu', () => {
    renderMessageContent();

    expect(screen.getByTestId('message-report-btn')).toBeInTheDocument();
  });

  it('no longer duplicates the action inside the More options menu', () => {
    renderAndOpenActionsMenu();

    expect(screen.queryByText('Report')).not.toBeInTheDocument();
  });

  it('opens the report modal for the current session and message on click', () => {
    renderMessageContent();

    fireEvent.click(screen.getByTestId('message-report-btn'));

    const modal = screen.getByTestId('bug-report-modal-mock');
    expect(modal).toHaveAttribute('data-session-id', 'session-1');
    expect(modal).toHaveAttribute('data-quest-id', 'quest-1');
  });

  it('leaves the report button unannotated when this message has no feedback on record', () => {
    mocks.sessionFeedback = [];

    renderMessageContent();

    // The reported state lives on the button itself; the tooltip title is its
    // accessible name, so that is what says which state it is in.
    expect(screen.getByTestId('message-report-btn')).toHaveAccessibleName('Report an issue with this message');
  });

  it('marks the report button when this message has a recorded report', () => {
    mocks.sessionFeedback = [{ questId: 'quest-1' }];

    renderMessageContent();

    expect(screen.getByTestId('message-report-btn')).toHaveAccessibleName('You already reported this message');
  });

  it('rests a reported message on the word, with the actions behind hover', () => {
    mocks.sessionFeedback = [{ questId: 'quest-1' }];

    renderMessageContent();

    expect(screen.getByTestId('message-reported-badge')).toHaveTextContent('Reported');
  });

  it('shows no reported word when this message has no feedback on record', () => {
    mocks.sessionFeedback = [];

    renderMessageContent();

    expect(screen.queryByTestId('message-reported-badge')).not.toBeInTheDocument();
  });

  it('does not annotate a message that was not itself reported', () => {
    mocks.sessionFeedback = [{ questId: 'some-other-quest' }];

    renderMessageContent();

    expect(screen.getByTestId('message-report-btn')).toHaveAccessibleName('Report an issue with this message');
  });

  // A send that failed leaves the bubble on its optimistic id with status 'done', so the action
  // row renders for a message the server has no row for. Sending that id as `questId` is a claim
  // resolveFeedbackContext drops on the floor; the report is a notebook-level one, and the button
  // has to say so rather than promising a per-message annotation that can never appear.
  const optimisticMessageData = {
    id: 'optimistic-quest-abc',
    prompt: 'hello',
    replies: ['**Error:** something went wrong'],
    status: 'done',
  } as unknown as IChatHistoryItem;

  it('sends no questId for a message that was never persisted', () => {
    renderMessageContent(optimisticMessageData);

    fireEvent.click(screen.getByTestId('message-report-btn'));

    const modal = screen.getByTestId('bug-report-modal-mock');
    expect(modal).toHaveAttribute('data-session-id', 'session-1');
    expect(modal).not.toHaveAttribute('data-quest-id');
  });

  it('labels the report as notebook-level on a message that was never persisted', () => {
    renderMessageContent(optimisticMessageData);

    expect(screen.getByTestId('message-report-btn')).toHaveAttribute(
      'aria-label',
      'Report an issue with this notebook'
    );
  });

  it('never annotates an unpersisted message, even if the session carries a matching report', () => {
    mocks.sessionFeedback = [{ questId: 'optimistic-quest-abc' }];

    renderMessageContent(optimisticMessageData);

    expect(screen.getByTestId('message-report-btn')).toHaveAccessibleName('Report an issue with this notebook');
  });

  it('invalidates the session-scoped feedback cache once the modal reports a successful submit', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderMessageContent(messageData, queryClient);

    fireEvent.click(screen.getByTestId('message-report-btn'));
    fireEvent.click(screen.getByTestId('bug-report-modal-mock-submit'));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['feedback', 'session', 'session-1', 'user-1'] });
  });

  describe('mobile action bar', () => {
    const desktopWidth = window.innerWidth;

    beforeEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true, writable: true });
    });

    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: desktopWidth, configurable: true, writable: true });
    });

    it('renders the persistent Report button', () => {
      renderMessageContent();

      expect(document.querySelector('.action-buttons-mobile')).not.toBeNull();
      expect(screen.getByTestId('message-report-btn')).toBeInTheDocument();
    });
  });
});

describe('MessageContent per-message credits-used chip - enforceCredits gating', () => {
  // Regression coverage: nothing decrements while enforceCredits is off, so the chip
  // must stay hidden even when the user has opted in and the message carries a value.
  const creditsMessageData = { ...messageData, creditsUsed: 42 } as unknown as IChatHistoryItem;

  it('shows the chip when enforcement is on and the user opted in', () => {
    mocks.serverSettings = [{ settingName: 'enforceCredits', settingValue: true }];
    mocks.showCreditsUsed = true;

    renderMessageContent(creditsMessageData);

    expect(screen.getByTestId('credits-used')).toBeInTheDocument();
  });

  it('hides the chip when enforceCredits is off, even with a credits value present', () => {
    mocks.serverSettings = [{ settingName: 'enforceCredits', settingValue: false }];
    mocks.showCreditsUsed = true;

    renderMessageContent(creditsMessageData);

    expect(screen.queryByTestId('credits-used')).not.toBeInTheDocument();
  });

  it('hides the chip when the enforceCredits setting is unset (self-host default)', () => {
    mocks.serverSettings = [];
    mocks.showCreditsUsed = true;

    renderMessageContent(creditsMessageData);

    expect(screen.queryByTestId('credits-used')).not.toBeInTheDocument();
  });
});
