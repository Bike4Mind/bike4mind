import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeToggle from './DataLakeToggle';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';

const { isFeatureEnabled, setCurrentSession, updateSession, toastError } = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(() => true),
  setCurrentSession: vi.fn(),
  updateSession: vi.fn(),
  toastError: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for ISessionDocument
let currentSession: any = { id: 's1', name: 'Chat', forceKnowledgeRetrieval: false };

vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession, setCurrentSession }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useUpdateSession: () => ({ mutate: updateSession }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('DataLakeToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFeatureEnabled.mockReturnValue(true);
    currentSession = { id: 's1', name: 'Chat', forceKnowledgeRetrieval: false };
    useDataLakeMode.setState({ enabled: false, seededSessionId: 's1' });
  });

  it('renders when the flag is on and a session exists', () => {
    wrap(<DataLakeToggle />);
    expect(screen.getByTestId('datalake-mode-toggle')).toBeInTheDocument();
  });

  it('turning on: updates store, optimistically updates the session, and persists', () => {
    wrap(<DataLakeToggle />);
    fireEvent.click(screen.getByTestId('datalake-mode-toggle'));
    expect(useDataLakeMode.getState().enabled).toBe(true);
    expect(setCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: true })
    );
    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: true }),
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('turning off: flips the store back to false and persists forceKnowledgeRetrieval:false', () => {
    useDataLakeMode.setState({ enabled: true, seededSessionId: 's1' });
    currentSession = { id: 's1', name: 'Chat', forceKnowledgeRetrieval: true };
    wrap(<DataLakeToggle />);
    fireEvent.click(screen.getByTestId('datalake-mode-toggle'));
    expect(useDataLakeMode.getState().enabled).toBe(false);
    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: false }),
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('rolls back the optimistic toggle when persistence fails', () => {
    updateSession.mockImplementationOnce((_session: unknown, opts?: { onError?: () => void }) => opts?.onError?.());
    wrap(<DataLakeToggle />);
    fireEvent.click(screen.getByTestId('datalake-mode-toggle'));
    expect(updateSession).toHaveBeenCalled();
    // setCurrentSession is called twice: optimistic (forceKnowledgeRetrieval: true), then the rollback
    // to the original pre-toggle session - assert the last call is the reverted one.
    expect(setCurrentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: false })
    );
    expect(toastError).toHaveBeenCalled();
    expect(useDataLakeMode.getState().enabled).toBe(false); // rolled back from the optimistic true
  });

  it('renders nothing when the admin flag is off', () => {
    isFeatureEnabled.mockReturnValue(false);
    const { container } = wrap(<DataLakeToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders on /new (no session) and toggling flips the store without persisting', () => {
    currentSession = null;
    wrap(<DataLakeToggle />);
    fireEvent.click(screen.getByTestId('datalake-mode-toggle'));
    expect(useDataLakeMode.getState().enabled).toBe(true);
    expect(updateSession).not.toHaveBeenCalled();
  });
});
