import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * On phones the composer row keeps only the plus button and the model, so Tools and Agents open
 * from the plus menu, each row showing the count the desktop buttons show.
 */

const hoisted = vi.hoisted(() => ({
  features: new Set<string>(['enableAgents']),
  activeToolsCount: 0,
  toolMode: 'smart' as 'smart' | 'fast',
  store: {
    openModal: vi.fn(),
    setAgentsDropdownOpen: vi.fn(),
    setToolsDropdownOpen: vi.fn(),
  },
  llm: {
    tools: [] as string[],
    agentMode: { enabled: false, source: 'toggle' },
    researchMode: { enabled: false, configurations: [] as unknown[] },
    model: 'gpt-4.1-2025-04-14',
  },
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
  useSessions: () => ({ workBenchAgents: [{}, {}], currentSessionId: undefined, currentSession: undefined }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: vi.fn() }));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/components/Session/AISettings/useActiveTools', () => ({
  useActiveTools: () => ({ activeToolsCount: hoisted.activeToolsCount, toolMode: hoisted.toolMode }),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: Object.assign((select: (s: typeof hoisted.llm) => unknown) => select(hoisted.llm), {
    setState: vi.fn(),
  }),
}));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: (select: (s: typeof hoisted.store) => unknown) => select(hoisted.store),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: (feature: string) => hoisted.features.has(feature) }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { experimentalFeatures: {} } }),
}));
vi.mock('@client/app/utils/commands', () => ({ isImageModel: () => false }));
vi.mock('@client/app/components/commands/RollCommand', () => ({ handleRollCommand: vi.fn() }));
vi.mock('@client/app/components/common/CountBadge', () => ({
  default: ({ count }: { count: number }) => (count ? <span data-testid="row-count">{count}</span> : null),
}));
vi.mock('@client/app/utils/googleDrivePickerStyles', () => ({ ensureGoogleDrivePickerStyles: vi.fn() }));

import AttachFileButton from './AttachFileButton';

const appTheme = extendTheme({ ...getThemeConfig() });

const openMenu = (props: { chatInputValue?: string; onOptimizePrompt?: () => void } = {}) => {
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

describe('AttachFileButton plus menu (phone)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeToolsCount = 0;
    hoisted.toolMode = 'smart';
  });

  it('opens the Tools panel from its row', () => {
    openMenu();
    fireEvent.click(screen.getByTestId('attach-menu-tools-btn'));
    expect(hoisted.store.setToolsDropdownOpen).toHaveBeenCalledWith(true);
  });

  it('shows how many tools are on', () => {
    hoisted.activeToolsCount = 3;
    openMenu();
    expect(within(screen.getByTestId('attach-menu-tools-btn')).getByTestId('row-count')).toHaveTextContent('3');
  });

  it('names Fast mode on the Tools row', () => {
    hoisted.toolMode = 'fast';
    openMenu();
    expect(screen.getByTestId('attach-menu-tools-btn')).toHaveTextContent('Fast Tools');
  });

  it('opens the Agents panel from its row, with the agent count', () => {
    openMenu();
    const row = screen.getByTestId('attach-menu-agents-btn');
    expect(within(row).getByTestId('row-count')).toHaveTextContent('2');
    fireEvent.click(row);
    expect(hoisted.store.setAgentsDropdownOpen).toHaveBeenCalledWith(true);
  });

  it('lists Optimize Prompt before there is a prompt, but waits for one', () => {
    const onOptimizePrompt = vi.fn();
    openMenu({ chatInputValue: '  ', onOptimizePrompt });
    const row = screen.getByTestId('attach-menu-optimize-btn');
    expect(row).toHaveTextContent('Type a prompt first');
    fireEvent.click(row);
    expect(onOptimizePrompt).not.toHaveBeenCalled();
  });

  it('optimizes once there is a prompt', () => {
    const onOptimizePrompt = vi.fn();
    openMenu({ chatInputValue: 'draft a reply', onOptimizePrompt });
    fireEvent.click(screen.getByTestId('attach-menu-optimize-btn'));
    expect(onOptimizePrompt).toHaveBeenCalledTimes(1);
  });
});
