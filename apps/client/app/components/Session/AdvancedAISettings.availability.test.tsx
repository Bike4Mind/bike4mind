import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The composer's tool indicators (the green primary-tool icons and the "+N" badge)
 * must agree with the Tools picker: a tool whose API key is missing renders off
 * there, so it must not show an icon or inflate the badge here.
 *
 * Asserts on the props handed to ToolsButton rather than the rendered icons, since
 * ToolIndicators is presentational - it draws whatever it is given, so the wiring in
 * this component is where the two surfaces can drift apart.
 */

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    tools: [] as string[],
    toolMode: 'smart',
    enabledMcpServers: null,
    isQuestMasterEnabled: false,
    isAgentsEnabled: false,
    isLatticeEnabled: false,
    model: 'gpt-4o',
    thinking: { enabled: false, budget_tokens: 16000 },
    quality: 'standard',
    n: 1,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const toolAvailability = { value: undefined as Record<string, boolean> | undefined };
  const toolsButtonProps = { value: null as Record<string, unknown> | null };
  return { state, useLLM, toolAvailability, toolsButtonProps };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: mocks.useLLM }));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: null, workBenchAgents: [] }),
}));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/mcpServers', () => ({ useMcpServers: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { toolAvailability: mocks.toolAvailability.value } }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }] }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false, useIsTablet: () => false }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isAdminFeatureEnabled: () => false }),
}));
vi.mock('./AISettings/useHydrateModelFromSession', () => ({ useHydrateModelFromSession: () => {} }));
vi.mock('./AISettings/useAdvancedAISettingsStore', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same shape of test double as useLLM
  useAdvancedAISettings: (selector: any) =>
    selector({ showAdvancedSettings: false, setShowAdvancedSettings: vi.fn(), setPromptBuilderOpen: vi.fn() }),
}));
vi.mock('./PromptBuilder/usePromptBuilderFirstRun', () => ({
  usePromptBuilderFirstRun: () => ({ showHint: false, markSeen: vi.fn() }),
}));
vi.mock('./AISettings/InspectableSettingsButton', () => ({ default: () => null }));
vi.mock('./AISettings/AdvancedAIModal', () => ({ AdvancedAIModal: () => null }));
vi.mock('./AISettings/AgentsButton', () => ({ default: () => null }));
vi.mock('./AISettings/BriefcaseButton', () => ({ default: () => null }));
vi.mock('./AISettings/ResearchModeIndicator', () => ({ default: () => null }));
vi.mock('./ImageTemplates/ImageTemplateControls', () => ({ ImageTemplateControls: () => null }));
vi.mock('./PromptBuilder/PromptBuilderModal', () => ({ PromptBuilderModal: () => null }));
vi.mock('./AISettings/ToolsButton', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.toolsButtonProps.value = props;
    return null;
  },
}));

import AdvancedAISettings from './AdvancedAISettings';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderIndicators = () => {
  render(
    <AdvancedAISettings
      stream={false}
      setStream={vi.fn()}
      spokenWords={0}
      setSpokenWords={vi.fn()}
      onRollDice={vi.fn()}
      currentSession={null}
    />,
    { wrapper: Wrapper }
  );
  const props = mocks.toolsButtonProps.value;
  return {
    activePrimaryTools: props?.activePrimaryTools as string[],
    otherActiveToolsCount: props?.otherActiveToolsCount as number,
    tools: props?.tools as string[],
  };
};

beforeEach(() => {
  mocks.state.tools = [];
  mocks.toolAvailability.value = undefined;
  mocks.toolsButtonProps.value = null;
});

describe('AdvancedAISettings tool indicators vs availability', () => {
  it('drops an unavailable primary tool from the indicator icons', () => {
    mocks.state.tools = ['web_search', 'web_fetch'];
    mocks.toolAvailability.value = { web_search: false };
    expect(renderIndicators().activePrimaryTools).toEqual(['web_fetch']);
  });

  it('drops an unavailable non-primary tool from the "+N" badge count', () => {
    mocks.state.tools = ['search_knowledge_base', 'math_evaluate'];
    mocks.toolAvailability.value = { search_knowledge_base: false };
    expect(renderIndicators().otherActiveToolsCount).toBe(1);
  });

  // Control: proves the two assertions above track availability rather than always
  // shrinking the lists.
  it('keeps both when the keys are present', () => {
    mocks.state.tools = ['web_search', 'search_knowledge_base'];
    mocks.toolAvailability.value = { web_search: true, search_knowledge_base: true };
    const indicators = renderIndicators();
    expect(indicators.activePrimaryTools).toEqual(['web_search']);
    expect(indicators.otherActiveToolsCount).toBe(1);
  });

  // Control against an over-fix: availability is undefined until /serverConfig
  // resolves, and treating that as missing would blank the indicators on first paint.
  it('keeps both while availability is still loading', () => {
    mocks.state.tools = ['web_search', 'search_knowledge_base'];
    mocks.toolAvailability.value = undefined;
    const indicators = renderIndicators();
    expect(indicators.activePrimaryTools).toEqual(['web_search']);
    expect(indicators.otherActiveToolsCount).toBe(1);
  });

  // ToolsButton's `tools` prop becomes ToolsSection's propTools, which
  // handleToggleTool reads and rewrites. Handing it the filtered list would drop a
  // key-gated preference the moment any other tool is toggled.
  it('still hands ToolsButton the unfiltered preference array', () => {
    mocks.state.tools = ['web_search', 'search_knowledge_base'];
    mocks.toolAvailability.value = { web_search: false, search_knowledge_base: false };
    expect(renderIndicators().tools).toEqual(['web_search', 'search_knowledge_base']);
  });
});
