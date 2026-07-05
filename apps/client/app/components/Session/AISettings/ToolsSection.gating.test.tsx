import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Regression coverage for the per-mode tool gating in ToolsSection. The key
 * invariant: Agent-mode dimming must gate on the Layer-1
 * `experimentalFeatures.agentMode` flag (the bolt button / real routing gate in
 * useSendMessage), NOT on `enableAgents` / isAgentsEnabled (the unrelated
 * "@help Agent Detection" feature). A dogfooder can have agentMode on while
 * enableAgents is off; the dimming must still apply for them.
 *
 * Asserts on the `data-tool-disabled` attribute ToolContainer sets when a row is
 * gated, so we don't depend on hovering the MUI tooltip.
 */

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    tools: [],
    toolMode: 'smart',
    isQuestMasterEnabled: false,
    isAgentsEnabled: false,
    agentMode: { enabled: true, source: 'toggle' },
    isLatticeEnabled: false,
    researchMode: { enabled: false },
    enabledMcpServers: null,
    model: 'gpt-4o',
    thinking: { enabled: false, budget_tokens: 16000 },
    disableAutoRouteForThisSession: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const experimentalAgentMode = { value: true };
  // Controls for the predicted complexity auto-route path.
  const agentModeFeatureFlag = { value: false }; // isFeatureEnabled('agentMode')
  const agentModeDefault = { value: 'off' as 'off' | 'auto' | 'on' };
  const chatDraft = { value: '' };
  const liveAI = { value: true }; // useAdvancedAISettings(state => state.liveAI); default on
  return { state, useLLM, experimentalAgentMode, agentModeFeatureFlag, agentModeDefault, chatDraft, liveAI };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: mocks.useLLM }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: (selector: (s: { liveAI: boolean }) => unknown) => selector({ liveAI: mocks.liveAI.value }),
}));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: (selector: (s: { chatInputValue: string }) => unknown) =>
    selector({ chatInputValue: mocks.chatDraft.value }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({
    settings: {
      toolsCatalogCollapsed: false,
      rechartsDisplayMode: 'inline',
      experimentalFeatures: { agentMode: mocks.experimentalAgentMode.value },
      agentModeDefault: mocks.agentModeDefault.value,
    },
    updatePreferences: vi.fn(),
  }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: (feature: string) => (feature === 'agentMode' ? mocks.agentModeFeatureFlag.value : false),
    isAdminFeatureEnabled: () => false,
  }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({
    data: [
      { id: 'gpt-4o', name: 'GPT-4o', supportsTools: true },
      { id: 'gpt-image-1', name: 'GPT Image 1', supportsTools: true },
    ],
  }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useMcpServers: () => ({ data: [], isPending: false, isFetching: false }),
}));
vi.mock('./DeepResearchConfigModal', () => ({ default: () => null }));
vi.mock('./ImageGenerationModelSelectionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ToolsSection from './ToolsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const gated = (container: HTMLElement, toolClass: string) =>
  container.querySelector(`.${toolClass} [data-tool-disabled="true"]`);

beforeEach(() => {
  mocks.state.isAgentsEnabled = false;
  mocks.state.toolMode = 'smart';
  mocks.state.agentMode = { enabled: true, source: 'toggle' };
  mocks.state.disableAutoRouteForThisSession = false;
  mocks.state.model = 'gpt-4o';
  mocks.experimentalAgentMode.value = true;
  mocks.agentModeFeatureFlag.value = false;
  mocks.agentModeDefault.value = 'off';
  mocks.chatDraft.value = '';
  mocks.liveAI.value = true;
});

// A draft that scores 'complex' (3 indicators: analytical verb + why/because +
// 4-digit year), enough to trip the rule-based complexity auto-route.
const COMPLEX_DRAFT = 'Please analyze and compare the 2020 data because I want the reasons behind it.';

describe('ToolsSection agent-mode gating', () => {
  it('dims agent-disallowed tools when the agentMode feature is on + bolt on, even with enableAgents off', () => {
    mocks.state.isAgentsEnabled = false; // enableAgents OFF
    mocks.agentModeFeatureFlag.value = true; // resolved agentMode feature ON (honors admin default)
    // bolt ON via beforeEach (agentMode.enabled: true); draft stays empty on purpose.
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    // Wolfram Alpha is not in the agent toolset -> gated (regardless of prompt).
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
    // Web Search and Excel are in the agent toolset -> not gated.
    expect(gated(container, 'tool-item-web-search')).toBeFalsy();
    expect(gated(container, 'tool-item-excel-generation')).toBeFalsy();
  });

  // bolt ON must grey even when agentMode is enabled via the admin DEFAULT
  // (resolved flag true) rather than an explicit user pref.
  it('dims with bolt on when agentMode is enabled only via the admin default (raw pref unset)', () => {
    mocks.agentModeFeatureFlag.value = true; // resolved flag true (admin default)
    mocks.experimentalAgentMode.value = false; // raw user pref NOT set
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
  });

  it('does not dim when the agentMode feature is off (even with the bolt on + enableAgents on)', () => {
    mocks.state.isAgentsEnabled = true; // enableAgents ON, but...
    mocks.agentModeFeatureFlag.value = false; // ...agentMode feature OFF (bolt still on via beforeEach)
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });

  it('dims every tool in Fast mode regardless of agent mode', () => {
    mocks.state.toolMode = 'fast';
    mocks.experimentalAgentMode.value = false;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-web-search')).toBeTruthy();
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
  });
});

// The Tools panel must grey the agent-ignored tools BEFORE send when the current
// draft would silently auto-route on complexity - even with the explicit Agent-mode
// toggle OFF. Predicted path requires: enableAgents on + Smart Routing 'auto'
// (agentMode feature flag + agentModeDefault) + a complex draft + not opted out for
// the session.
describe('ToolsSection complexity auto-route gating', () => {
  beforeEach(() => {
    // Isolate the predicted path from the explicit-toggle path.
    mocks.experimentalAgentMode.value = false; // bolt/toggle OFF
    mocks.state.agentMode = { enabled: false, source: 'toggle' };
    mocks.state.isAgentsEnabled = true; // enableAgents ON
    mocks.agentModeFeatureFlag.value = true; // agentMode feature available
    mocks.agentModeDefault.value = 'auto'; // Smart Routing = Auto
  });

  it('dims agent-disallowed tools when the draft would auto-route on complexity', () => {
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    // Wolfram is not in the agent toolset -> greyed even though the toggle is OFF.
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
    // Web Search / Excel are in the agent toolset -> not greyed.
    expect(gated(container, 'tool-item-web-search')).toBeFalsy();
    expect(gated(container, 'tool-item-excel-generation')).toBeFalsy();
  });

  it('does NOT dim for a simple draft', () => {
    mocks.chatDraft.value = 'What planets are visible tonight?';
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });

  it('does NOT dim when the complex draft is a real slash command (runs the handler, never auto-routes)', () => {
    mocks.chatDraft.value = `/gen_image ${COMPLEX_DRAFT}`;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });

  it('does NOT dim on an image/video model (send injects a generation command, never auto-routes)', () => {
    // Plain complex draft (no slash prefix) on an image model: with liveAI on,
    // the send turns it into `/gen_image ...`, so it runs generation and never reroutes.
    mocks.state.model = 'gpt-image-1';
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });

  // The image/video bypass is gated on liveAI: with liveAI OFF the send does NOT
  // inject `/gen_image`, so a complex draft WOULD auto-route and the tools should
  // still grey.
  it('DOES dim on an image/video model when liveAI is off (no command injection -> still auto-routes)', () => {
    mocks.liveAI.value = false;
    mocks.state.model = 'gpt-image-1';
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
  });

  it('does NOT dim when Smart Routing is not Auto (even with a complex draft)', () => {
    mocks.agentModeDefault.value = 'off';
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });

  it('does NOT dim once auto-routing is dismissed for the session', () => {
    mocks.chatDraft.value = COMPLEX_DRAFT;
    mocks.state.disableAutoRouteForThisSession = true;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });
});
