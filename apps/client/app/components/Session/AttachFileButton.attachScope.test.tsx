import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ATTACH_SCOPE_MODES } from '@bike4mind/common';

/**
 * The attach-scope control: a list of radios with a description each, in a side panel opened from
 * the gear on the "Upload from Computer" row of the plus menu. Only device uploads honour it.
 */

const hoisted = vi.hoisted(() => ({ isFeatureEnabled: vi.fn(() => false) }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: {} }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => undefined }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({ useConnectGoogleDrive: () => vi.fn() }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('react-google-drive-picker', () => ({ default: () => [vi.fn()] }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => vi.fn() }));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useCreateNewSession: () => vi.fn(),
  useUpdateSession: () => vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ workBenchAgents: [], currentSessionId: undefined }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: vi.fn() }));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/components/Session/AISettings/useActiveTools', () => ({
  useActiveTools: () => ({ activeToolsCount: 0, toolMode: 'smart' }),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: () => [[]] }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: () => vi.fn(),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: hoisted.isFeatureEnabled }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: {} }),
}));
vi.mock('@client/app/components/commands/RollCommand', () => ({ handleRollCommand: vi.fn() }));
vi.mock('@client/app/components/common/CountBadge', () => ({ default: () => null }));
vi.mock('@client/app/utils/googleDrivePickerStyles', () => ({ ensureGoogleDrivePickerStyles: vi.fn() }));

import AttachFileButton from './AttachFileButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderControl = (attachScopeMode: (typeof ATTACH_SCOPE_MODES)[number] = 'auto') => {
  const onAttachScopeModeChange = vi.fn();
  render(
    <Wrapper>
      <AttachFileButton
        onUploadFromComputer={vi.fn()}
        onAddFromGoogleDrive={vi.fn()}
        onAddFromFileBrowser={vi.fn()}
        attachScopeMode={attachScopeMode}
        onAttachScopeModeChange={onAttachScopeModeChange}
      />
    </Wrapper>
  );
  // The control lives behind the upload row's gear, inside the menu, both mounted only while open.
  fireEvent.click(screen.getByTestId('attach-files-btn'));
  fireEvent.click(screen.getByTestId('upload-scope-settings-btn'));
  return { onAttachScopeModeChange };
};

describe('AttachFileButton attach-scope control', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders one labelled option per mode, so a new mode cannot ship unlabelled', () => {
    renderControl();
    expect(screen.getByTestId('attach-file-scope-radiogroup')).toBeInTheDocument();
    for (const mode of ATTACH_SCOPE_MODES) {
      expect(screen.getByTestId(`attach-file-scope-${mode}-radio`)).toBeInTheDocument();
    }
    expect(screen.getByText('Smart')).toBeInTheDocument();
    expect(screen.getByText('Whole notebook')).toBeInTheDocument();
    expect(screen.getByText('Just this message')).toBeInTheDocument();
  });

  it('checks the current mode', () => {
    renderControl('message');
    expect(screen.getByRole('radio', { name: 'Just this message' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Smart' })).not.toBeChecked();
  });

  it('reports a change when an option is chosen', () => {
    // By role, not by test id: the id lands on the Radio ROOT, and clicking a div toggles nothing.
    // The role query also asserts the label is the radio's accessible name, which is what a
    // screen-reader user hears and what makes the pill a real radio rather than a styled div.
    const { onAttachScopeModeChange } = renderControl('auto');
    fireEvent.click(screen.getByRole('radio', { name: 'Whole notebook' }));
    expect(onAttachScopeModeChange).toHaveBeenCalledWith('notebook');
  });

  it('describes every mode next to its option', () => {
    renderControl('auto');
    expect(screen.getByText('Nothing is kept - files attach to one message only.')).toBeInTheDocument();
    expect(
      screen.getByText('Everything is kept for this notebook and re\u2011sent with every message.')
    ).toBeInTheDocument();
  });

  it('keeps the gear on the upload row only, out of the way until clicked', () => {
    render(
      <Wrapper>
        <AttachFileButton
          onUploadFromComputer={vi.fn()}
          onAddFromGoogleDrive={vi.fn()}
          onAddFromFileBrowser={vi.fn()}
          attachScopeMode="auto"
          onAttachScopeModeChange={vi.fn()}
        />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('attach-files-btn'));
    expect(screen.queryByTestId('attach-file-scope-radiogroup')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('upload-scope-settings-btn'));
    expect(screen.getByTestId('attach-file-scope-radiogroup')).toBeInTheDocument();
  });
});

describe('AttachFileButton menu after a file is attached', () => {
  const button = (totalFilesCount: number) => (
    <Wrapper>
      <AttachFileButton
        onUploadFromComputer={vi.fn()}
        onAddFromGoogleDrive={vi.fn()}
        onAddFromFileBrowser={vi.fn()}
        attachScopeMode="auto"
        onAttachScopeModeChange={vi.fn()}
        totalFilesCount={totalFilesCount}
      />
    </Wrapper>
  );

  it('closes when the attached file count goes up', () => {
    const { rerender } = render(button(0));
    fireEvent.click(screen.getByTestId('attach-files-btn'));
    expect(screen.getByTestId('upload-from-device-btn')).toBeInTheDocument();

    rerender(button(1));
    expect(screen.queryByTestId('upload-from-device-btn')).not.toBeInTheDocument();
  });

  it('stays open when a file is removed', () => {
    const { rerender } = render(button(2));
    fireEvent.click(screen.getByTestId('attach-files-btn'));

    rerender(button(1));
    expect(screen.getByTestId('upload-from-device-btn')).toBeInTheDocument();
  });
});
