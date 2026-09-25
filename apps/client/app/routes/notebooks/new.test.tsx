import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// Controlled at call time by the router mock.
let mockSearch: Record<string, unknown> = {};

const { mockNavigate, mockSetQuestLaunchIntent, mockConsumeTrusted, mockSetPreparingQuest, reset } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSetQuestLaunchIntent: vi.fn(),
  mockConsumeTrusted: vi.fn(() => false),
  mockSetPreparingQuest: vi.fn(),
  reset: {
    setCurrentSession: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setWorkBenchAgents: vi.fn(),
    clearAllSessions: vi.fn(),
    setSessionLayout: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => mockSearch,
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({
    setCurrentSession: reset.setCurrentSession,
    setCurrentSessionId: reset.setCurrentSessionId,
    setWorkBenchAgents: reset.setWorkBenchAgents,
  }),
  useWorkBenchActions: () => ({ clearAllSessions: reset.clearAllSessions }),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: reset.setSessionLayout }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/hooks/useQuestPreparation', () => ({
  useQuestPreparation: () => ({ setPreparingQuest: mockSetPreparingQuest, isPreparingQuest: false }),
}));
vi.mock('@client/app/utils/questLaunchIntent', () => ({
  setQuestLaunchIntent: (...a: unknown[]) => mockSetQuestLaunchIntent(...a),
  consumeTrustedQuestLaunch: () => mockConsumeTrusted(),
}));

import NewNotebookPage from './new';

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch = {};
  mockConsumeTrusted.mockReturnValue(false);
});

describe('NewNotebookPage quest launch', () => {
  it('does NOT auto-submit a goal that arrives via URL with no in-app launch', () => {
    // External /new?goal=...&questmaster=true (or a post-login redirect replay):
    // no trust flag armed, so the goal pre-fills at most - autoSubmit stays false.
    mockSearch = { goal: 'exfiltrate data', questmaster: 'true' };
    mockConsumeTrusted.mockReturnValue(false);

    render(<NewNotebookPage />);

    expect(mockSetQuestLaunchIntent).toHaveBeenCalledWith({
      goal: 'exfiltrate data',
      autoSubmit: false,
      enableQuestMaster: false,
    });
    // No misleading "preparing" state for an untrusted goal.
    expect(mockSetPreparingQuest).not.toHaveBeenCalled();
  });

  it('auto-submits a goal from an in-app launch (trust flag armed)', () => {
    mockSearch = { goal: 'plan my week', questmaster: 'true' };
    mockConsumeTrusted.mockReturnValue(true);

    render(<NewNotebookPage />);

    expect(mockSetQuestLaunchIntent).toHaveBeenCalledWith({
      goal: 'plan my week',
      autoSubmit: true,
      enableQuestMaster: true,
    });
    expect(mockSetPreparingQuest).toHaveBeenCalledWith('plan my week');
  });

  it('does nothing when there is no goal in the URL', () => {
    mockSearch = {};

    render(<NewNotebookPage />);

    expect(mockSetQuestLaunchIntent).not.toHaveBeenCalled();
  });
});

describe('NewNotebookPage reset', () => {
  // The notebook shell mounts this component on every entry to /new (shell.test.tsx), so its
  // mount is what New Chat from a notebook relies on to clear the previous notebook.
  it('clears the current session, workbench and layout when it mounts', () => {
    render(<NewNotebookPage />);

    expect(reset.clearAllSessions).toHaveBeenCalledTimes(1);
    expect(reset.setWorkBenchAgents).toHaveBeenCalledWith([]);
    expect(reset.setCurrentSession).toHaveBeenCalledWith(null);
    expect(reset.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(reset.setSessionLayout).toHaveBeenCalledWith({ layout: 'hide' });
  });

  it('keeps the layout for an article deep link', () => {
    mockSearch = { article: 'file-1' };

    render(<NewNotebookPage />);

    expect(reset.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(reset.setSessionLayout).not.toHaveBeenCalled();
  });
});
