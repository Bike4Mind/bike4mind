import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

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
    skipAutoOffers: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const toolAvailability = { value: undefined as Record<string, boolean> | undefined };
  const toolsButtonProps = { value: null as Record<string, unknown> | null };
  const modalProps = { value: null as Record<string, unknown> | null };
  const mcpServers = { value: [] as Array<{ name: string; enabled: boolean }> };
  const adminFeatureFlags = { value: {} as Record<string, boolean> };
  return { state, useLLM, toolAvailability, toolsButtonProps, modalProps, mcpServers, adminFeatureFlags };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: mocks.useLLM }));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: null, workBenchAgents: [] }),
}));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/mcpServers', () => ({ useMcpServers: () => ({ data: mocks.mcpServers.value }) }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { toolAvailability: mocks.toolAvailability.value } }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }] }),
  // Read by StaleModelPrompt, which this component renders; empty keeps it silent here.
  useSupersededModels: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false, useIsTablet: () => false }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: () => false,
    isAdminFeatureEnabled: (feature: string) => mocks.adminFeatureFlags.value[feature] ?? false,
  }),
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
vi.mock('./AISettings/AdvancedAIModal', () => ({
  AdvancedAIModal: (props: Record<string, unknown>) => {
    mocks.modalProps.value = props;
    return null;
  },
}));
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

const renderSettings = (currentSession: ISessionDocument | null = null) =>
  render(
    <AdvancedAISettings
      stream={false}
      setStream={vi.fn()}
      spokenWords={0}
      setSpokenWords={vi.fn()}
      onRollDice={vi.fn()}
      currentSession={currentSession}
    />,
    { wrapper: Wrapper }
  );

const renderIndicators = (currentSession: ISessionDocument | null = null) => {
  render(
    <AdvancedAISettings
      stream={false}
      setStream={vi.fn()}
      spokenWords={0}
      setSpokenWords={vi.fn()}
      onRollDice={vi.fn()}
      currentSession={currentSession}
    />,
    { wrapper: Wrapper }
  );
  const props = mocks.toolsButtonProps.value;
  return {
    activePrimaryTools: props?.activePrimaryTools as string[],
    otherActiveToolsCount: props?.otherActiveToolsCount as number,
    tools: props?.tools as string[],
    enabledMcpServers: props?.enabledMcpServers as string[] | null,
    disabledTools: props?.disabledTools as string[] | undefined,
  };
};

beforeEach(() => {
  mocks.state.tools = [];
  mocks.toolAvailability.value = undefined;
  mocks.toolsButtonProps.value = null;
  mocks.modalProps.value = null;
  mocks.mcpServers.value = [];
  mocks.state.enabledMcpServers = null;
  mocks.state.skipAutoOffers = false;
  mocks.state.model = 'gpt-4o';
  mocks.adminFeatureFlags.value = {};
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

/**
 * "Only tools I pick" feeds `offerOnlyNamedTools`, which withholds every non-agent-only MCP
 * tool server-side (sharedToolBuilder.ts). The indicator row reads only `enabledMcpServers`,
 * so without this it keeps advertising integrations that contribute nothing to the turn - the
 * same class of lie ToolsButton already avoids by hiding every indicator in Fast mode.
 */
describe('AdvancedAISettings MCP indicators vs "Only tools I pick"', () => {
  const connect = (...names: string[]) => {
    mocks.mcpServers.value = names.map(name => ({ name, enabled: true }));
  };

  it('advertises every enabled integration when the flag is off', () => {
    connect('notion', 'linkedin', 'atlassian');
    const indicators = renderIndicators();
    expect(indicators.enabledMcpServers).toEqual(['notion', 'linkedin', 'atlassian']);
    expect(indicators.otherActiveToolsCount).toBe(2);
  });

  it('drops the integrations the flag withholds', () => {
    connect('notion', 'linkedin');
    mocks.state.skipAutoOffers = true;
    const indicators = renderIndicators();
    expect(indicators.enabledMcpServers).toEqual([]);
    expect(indicators.otherActiveToolsCount).toBe(0);
  });

  // Agent-only servers are exempt from the gate (sharedToolBuilder.ts keeps routing them into
  // the delegation pool), so blanking them too would swap one wrong indicator for another.
  it('keeps an agent-only integration, which the gate exempts', () => {
    connect('notion', 'atlassian');
    mocks.state.skipAutoOffers = true;
    expect(renderIndicators().enabledMcpServers).toEqual(['atlassian']);
  });

  // The flag narrows what the server offers; it never re-enables a server the user turned off.
  it('does not resurrect a server the user disabled', () => {
    connect('notion', 'atlassian');
    mocks.state.enabledMcpServers = ['notion'];
    mocks.state.skipAutoOffers = true;
    expect(renderIndicators().enabledMcpServers).toEqual([]);
  });
});

/**
 * `session.disabledTools` is enforced server-side ahead of every other gate, so a denied tool
 * never reaches the model. The indicators must not advertise it, and the panel must hide it.
 */
describe('AdvancedAISettings indicators vs session-denied tools', () => {
  const sessionDenying = (...disabledTools: string[]) => ({ disabledTools }) as unknown as ISessionDocument;

  it('drops a denied primary tool from the indicator icons', () => {
    mocks.state.tools = ['web_search', 'image_generation'];
    expect(renderIndicators(sessionDenying('image_generation')).activePrimaryTools).toEqual(['web_search']);
  });

  it('drops a denied non-primary tool from the "+N" badge count', () => {
    mocks.state.tools = ['music_generation', 'math_evaluate'];
    expect(renderIndicators(sessionDenying('music_generation')).otherActiveToolsCount).toBe(1);
  });

  it('hands the denylist to ToolsButton, with the preference array unfiltered', () => {
    mocks.state.tools = ['image_generation'];
    const indicators = renderIndicators(sessionDenying('image_generation'));
    expect(indicators.disabledTools).toEqual(['image_generation']);
    expect(indicators.tools).toEqual(['image_generation']);
  });

  it('changes nothing without a session', () => {
    mocks.state.tools = ['web_search', 'image_generation'];
    const indicators = renderIndicators(null);
    expect(indicators.activePrimaryTools).toEqual(['web_search', 'image_generation']);
    expect(indicators.disabledTools).toBeUndefined();
  });
});

describe('AdvancedAISettings toolbar buttons vs session-denied tools', () => {
  const sessionDenying = (...disabledTools: string[]) => ({ disabledTools }) as unknown as ISessionDocument;
  const withPromptBuilder = () => {
    mocks.adminFeatureFlags.value = { EnablePromptBuilder: true };
    mocks.state.model = 'gpt-image-1';
  };

  it('hides the Prompt Builder button when image_generation is denied', () => {
    withPromptBuilder();
    const { queryByTestId } = renderSettings(sessionDenying('image_generation'));
    expect(queryByTestId('prompt-builder-open-btn')).toBeNull();
  });

  // Control: proves the button renders under these mocks, so the test above is not vacuous.
  it('shows the Prompt Builder button when nothing is denied', () => {
    withPromptBuilder();
    const { queryByTestId } = renderSettings(null);
    expect(queryByTestId('prompt-builder-open-btn')).toBeTruthy();
  });

  it('hides the dice icon when dice_roll is denied', () => {
    mocks.state.tools = ['dice_roll'];
    const { container } = renderSettings(sessionDenying('dice_roll'));
    expect(container.querySelector('[data-testid="CasinoIcon"]')).toBeNull();
  });

  it('shows the dice icon when nothing is denied', () => {
    mocks.state.tools = ['dice_roll'];
    const { container } = renderSettings(null);
    expect(container.querySelector('[data-testid="CasinoIcon"]')).toBeTruthy();
  });
});

describe('AdvancedAISettings modal vs session-denied tools', () => {
  const sessionDenying = (...disabledTools: string[]) => ({ disabledTools }) as unknown as ISessionDocument;

  it('hands the session denylist to AdvancedAIModal', () => {
    renderSettings(sessionDenying('dice_roll'));
    expect(mocks.modalProps.value).not.toBeNull();
    expect(mocks.modalProps.value?.disabledTools).toEqual(['dice_roll']);
  });

  it('hands it no denylist without a session', () => {
    renderSettings(null);
    expect(mocks.modalProps.value).not.toBeNull();
    expect(mocks.modalProps.value?.disabledTools).toBeUndefined();
  });
});
