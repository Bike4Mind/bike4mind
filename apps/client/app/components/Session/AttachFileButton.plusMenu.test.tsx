import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The plus menu took over the situational controls the composer row used to show: the Agent-mode
 * switch (still behind its admin gate), the prompt catalog and image options as side panels, and
 * Roll Dice on desktop too.
 */

const hoisted = vi.hoisted(() => ({
  features: new Set<string>(),
  researchModeFeature: false,
  llm: {
    tools: [] as string[],
    agentMode: { enabled: false, source: 'toggle' },
    researchMode: { enabled: false, configurations: [] as unknown[] },
    model: 'gpt-4.1-2025-04-14',
  },
  setState: vi.fn(),
}));

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
  useSessions: () => ({ workBenchAgents: [], currentSessionId: undefined, currentSession: undefined }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: vi.fn() }));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/components/Session/AISettings/useActiveTools', () => ({
  useActiveTools: () => ({ activeToolsCount: 0, toolMode: 'smart' }),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: Object.assign((select: (s: typeof hoisted.llm) => unknown) => select(hoisted.llm), {
    setState: hoisted.setState,
  }),
}));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: () => vi.fn(),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: (feature: string) => hoisted.features.has(feature) }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: { enableResearchMode: hoisted.researchModeFeature } } }),
}));
vi.mock('@client/app/utils/commands', () => ({ isImageModel: (model: string) => model.startsWith('gpt-image') }));
vi.mock('@client/app/components/commands/RollCommand', () => ({ handleRollCommand: vi.fn() }));
vi.mock('@client/app/components/common/CountBadge', () => ({ default: () => null }));
vi.mock('@client/app/utils/googleDrivePickerStyles', () => ({ ensureGoogleDrivePickerStyles: vi.fn() }));
vi.mock('@client/app/components/Briefcase/BriefcasePanel', () => ({
  BriefcasePanel: () => <div data-testid="briefcase-panel" />,
}));
vi.mock('@client/app/components/Session/AISettings/ImageOptionsPanel', () => ({
  default: () => <div data-testid="image-options-panel" />,
}));

import AttachFileButton from './AttachFileButton';

const appTheme = extendTheme({ ...getThemeConfig() });

const openMenu = (props: { agentModeDisabled?: boolean } = {}) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <AttachFileButton
        onUploadFromComputer={vi.fn()}
        onAddFromGoogleDrive={vi.fn()}
        onAddFromFileBrowser={vi.fn()}
        attachScopeMode="auto"
        onAttachScopeModeChange={vi.fn()}
        {...props}
      />
    </CssVarsProvider>
  );
  fireEvent.click(screen.getByTestId('attach-files-btn'));
};

describe('AttachFileButton plus menu (desktop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.features.clear();
    hoisted.researchModeFeature = false;
    hoisted.llm.researchMode = { enabled: false, configurations: [] };
    hoisted.llm.tools = [];
    hoisted.llm.agentMode = { enabled: false, source: 'toggle' };
    hoisted.llm.model = 'gpt-4.1-2025-04-14';
  });

  it('offers the Agent-mode switch when the admin gate is on, and flips it', () => {
    hoisted.features.add('agentMode');
    openMenu();
    fireEvent.click(screen.getByTestId('attach-menu-agent-mode-btn'));
    expect(hoisted.setState).toHaveBeenCalledWith({ agentMode: { enabled: true, source: 'toggle' } });
  });

  it('hides the Agent-mode switch when the admin kill switch is off', () => {
    openMenu();
    expect(screen.getByTestId('upload-from-device-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('attach-menu-agent-mode-btn')).toBeNull();
  });

  it('keeps the Agent-mode switch from changing while a turn is being sent', () => {
    hoisted.features.add('agentMode');
    openMenu({ agentModeDisabled: true });
    fireEvent.click(screen.getByTestId('attach-menu-agent-mode-btn'));
    expect(hoisted.setState).not.toHaveBeenCalled();
  });

  it('opens the prompt catalog in a side panel when Briefcase is enabled', () => {
    hoisted.features.add('enableBriefcase');
    openMenu();
    expect(screen.queryByTestId('briefcase-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('attach-menu-prompt-catalog-btn'));
    expect(screen.getByTestId('attach-menu-flyout')).toContainElement(screen.getByTestId('briefcase-panel'));
  });

  it('offers image options only while an image model is selected', () => {
    openMenu();
    expect(screen.queryByTestId('attach-menu-image-options-btn')).toBeNull();
  });

  it('opens image options in a side panel for an image model', () => {
    hoisted.llm.model = 'gpt-image-2';
    openMenu();
    fireEvent.click(screen.getByTestId('attach-menu-image-options-btn'));
    expect(screen.getByTestId('attach-menu-flyout')).toContainElement(screen.getByTestId('image-options-panel'));
  });

  it('turns Research Mode on from its switch, without leaving the menu', () => {
    hoisted.researchModeFeature = true;
    openMenu();
    fireEvent.click(screen.getByTestId('attach-menu-research-mode-switch'));
    expect(hoisted.setState).toHaveBeenCalledWith({ researchMode: { enabled: true, configurations: [] } });
    expect(screen.getByTestId('attach-menu-research-mode-btn')).toBeInTheDocument();
  });

  it('offers Roll Dice on desktop when the dice tool is on', () => {
    hoisted.llm.tools = ['dice_roll'];
    openMenu();
    expect(screen.getByTestId('attach-menu-roll-dice-btn')).toBeInTheDocument();
  });
});
