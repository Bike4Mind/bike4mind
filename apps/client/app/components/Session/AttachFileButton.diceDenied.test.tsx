import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The "Roll Dice" plus-menu item must follow the session denylist: a denied dice_roll is never
 * offered to the model, so the shortcut must not be offered to the user either.
 */

const hoisted = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(() => false),
  disabledTools: { value: undefined as string[] | undefined },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: {} }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => undefined }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({ useConnectGoogleDrive: () => vi.fn() }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => true }));
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
  useSessions: () => ({
    workBenchAgents: [],
    currentSessionId: undefined,
    currentSession: hoisted.disabledTools.value ? { disabledTools: hoisted.disabledTools.value } : undefined,
  }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: vi.fn() }));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/contexts/LLMContext', () => {
  const state = { tools: ['dice_roll'], agentMode: { enabled: false }, model: 'gpt-4.1-2025-04-14' };
  return { useLLM: Object.assign((select: (s: typeof state) => unknown) => select(state), { setState: vi.fn() }) };
});
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

const openMenu = () => {
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
};

describe('AttachFileButton mobile Roll Dice vs session-denied tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.disabledTools.value = undefined;
  });

  // Control: proves the menu item renders under these mocks, so the absence test is not vacuous.
  it('offers Roll Dice when dice_roll is enabled and not denied', () => {
    openMenu();
    expect(screen.getByText('Roll Dice')).toBeInTheDocument();
  });

  it('still offers Roll Dice when the session denies some other tool', () => {
    hoisted.disabledTools.value = ['image_generation'];
    openMenu();
    expect(screen.getByText('Roll Dice')).toBeInTheDocument();
  });

  it('hides Roll Dice when the session denies dice_roll', () => {
    hoisted.disabledTools.value = ['dice_roll'];
    openMenu();
    expect(screen.getByTestId('attach-files-btn')).toBeInTheDocument();
    expect(screen.queryByText('Roll Dice')).toBeNull();
  });
});
