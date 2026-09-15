import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Regression coverage for the per-mode tool gating in ToolsSection.
 *
 * The key invariant is now a NEGATIVE one: Agent mode must NOT dim Smart Tools.
 * An agentless agent-executor run carries the user's Smart Tools unioned with
 * the agent-mode defaults (see `resolveDispatchTools`), so no toggle below is
 * ignored and greying one would be a lie. The blocks below keep the mocks for
 * the inputs that used to drive that dimming - the bolt, Smart Routing 'auto',
 * the draft text, liveAI - so re-introducing any of those paths fails here.
 *
 * Fast mode and missing-key gating are unaffected and still dim.
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
  // serverConfig.toolAvailability from useConfig(); undefined = not yet loaded (never gates).
  const toolAvailability = { value: undefined as Record<string, boolean> | undefined };
  // Admin feature flags (isAdminFeatureEnabled); default all off so rows behind a flag
  // (e.g. the Knowledge Base row) stay hidden unless a test opts in.
  const adminFeatureFlags = { value: {} as Record<string, boolean> };
  return {
    state,
    useLLM,
    experimentalAgentMode,
    agentModeFeatureFlag,
    agentModeDefault,
    chatDraft,
    liveAI,
    toolAvailability,
    adminFeatureFlags,
  };
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
    isAdminFeatureEnabled: (feature: string) => mocks.adminFeatureFlags.value[feature] ?? false,
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
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { toolAvailability: mocks.toolAvailability.value } }),
}));
vi.mock('./DeepResearchConfigModal', () => ({ default: () => null }));
vi.mock('./ImageGenerationModelSelectionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ToolsSection, { MISSING_KEY_TOOLTIPS } from './ToolsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const gated = (container: HTMLElement, toolClass: string) =>
  container.querySelector(`.${toolClass} [data-tool-disabled="true"]`);

// Asserts a row is RENDERED and not dimmed. `gated()` alone returns null for a
// row that never mounted, so a bare toBeFalsy() would pass vacuously if the
// tool ever stopped rendering - and every assertion in the two agent-mode
// blocks below is a negative one, with no positive control of its own.
const expectNotDimmed = (container: HTMLElement, toolClass: string) => {
  expect(container.querySelector(`.${toolClass}`)).toBeTruthy();
  expect(gated(container, toolClass)).toBeFalsy();
};

beforeEach(() => {
  mocks.state.tools = [];
  mocks.useLLM.setState.mockClear();
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
  mocks.toolAvailability.value = undefined;
  mocks.adminFeatureFlags.value = {};
});

// A draft that scores 'complex' (3 indicators: analytical verb + why/because +
// 4-digit year), enough to trip the rule-based complexity auto-route.
const COMPLEX_DRAFT = 'Please analyze and compare the 2020 data because I want the reasons behind it.';

describe('ToolsSection agent-mode gating', () => {
  it('does NOT dim tools outside the agent default toolset when the feature is on + bolt on', () => {
    mocks.state.isAgentsEnabled = false;
    mocks.agentModeFeatureFlag.value = true; // resolved agentMode feature ON (honors admin default)
    // bolt ON via beforeEach (agentMode.enabled: true).
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    // Wolfram Alpha is not in the agent-mode DEFAULT toolset, but the dispatch
    // unions the user's Smart Tools with those defaults, so it still runs.
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
    expectNotDimmed(container, 'tool-item-web-search');
    expectNotDimmed(container, 'tool-item-excel-generation');
  });

  it('does NOT dim with bolt on when agentMode is enabled via the admin default (raw pref unset)', () => {
    mocks.agentModeFeatureFlag.value = true;
    mocks.experimentalAgentMode.value = false;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
  });

  it('does not dim when the agentMode feature is off (even with the bolt on + enableAgents on)', () => {
    mocks.state.isAgentsEnabled = true;
    mocks.agentModeFeatureFlag.value = false;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
  });

  it('dims every tool in Fast mode regardless of agent mode', () => {
    mocks.state.toolMode = 'fast';
    mocks.experimentalAgentMode.value = false;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-web-search')).toBeTruthy();
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
  });
});

// The panel used to predict a complexity auto-route from the draft and grey the
// tools that route would have ignored. It ignores none of them now, so the
// prediction is gone and none of these inputs may dim anything. Each case below
// is a configuration that previously dimmed.
describe('ToolsSection complexity auto-route gating', () => {
  beforeEach(() => {
    mocks.experimentalAgentMode.value = false; // bolt/toggle OFF
    mocks.state.agentMode = { enabled: false, source: 'toggle' };
    mocks.state.isAgentsEnabled = true; // enableAgents ON
    mocks.agentModeFeatureFlag.value = true; // agentMode feature available
    mocks.agentModeDefault.value = 'auto'; // Smart Routing = Auto
  });

  it('does NOT dim when the draft would auto-route on complexity', () => {
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
    expectNotDimmed(container, 'tool-item-web-search');
    expectNotDimmed(container, 'tool-item-excel-generation');
  });

  it('does NOT dim for a simple draft', () => {
    mocks.chatDraft.value = 'What planets are visible tonight?';
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
  });

  it('does NOT dim on an image/video model with liveAI off (the last case that still dimmed)', () => {
    mocks.liveAI.value = false;
    mocks.state.model = 'gpt-image-1';
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
  });

  it('does NOT dim when Smart Routing is not Auto (even with a complex draft)', () => {
    mocks.agentModeDefault.value = 'off';
    mocks.chatDraft.value = COMPLEX_DRAFT;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expectNotDimmed(container, 'tool-item-wolfram-alpha');
  });
});

// A tool whose required API key is missing (serverConfig.toolAvailability[id] ===
// false) must be dimmed regardless of mode - otherwise it silently returns empty
// results. Availability that hasn't loaded yet (undefined) must NOT gate.
describe('ToolsSection missing-key gating', () => {
  it('dims a tool whose key is reported missing, and leaves configured tools alone', () => {
    mocks.toolAvailability.value = { web_search: false, wolfram_alpha: true };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-web-search')).toBeTruthy();
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeFalsy();
  });

  it('does NOT dim on missing key while availability is still loading (undefined)', () => {
    mocks.toolAvailability.value = undefined;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-web-search')).toBeFalsy();
  });

  it('gates on missing key even in Smart mode with no agent routing', () => {
    mocks.toolAvailability.value = { wolfram_alpha: false };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-wolfram-alpha')).toBeTruthy();
  });

  // The KB tool's server availability boolean (search_knowledge_base) must actually drive the
  // dimming, not just the tooltip wording - a keyless self-host resolves it via the local Ollama
  // embedder (isLocalEmbedderAvailable), so a true value must leave the row enabled.
  it('dims the knowledge base when search_knowledge_base is false, and leaves it enabled when true', () => {
    // The KB row is behind the EnableKnowledgeBaseSearch admin flag; turn it on so it renders.
    mocks.adminFeatureFlags.value = { EnableKnowledgeBaseSearch: true };

    mocks.toolAvailability.value = { search_knowledge_base: false };
    const { container: disabled } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(disabled, 'tool-item-knowledge-base')).toBeTruthy();

    mocks.toolAvailability.value = { search_knowledge_base: true };
    const { container: enabled } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(enabled, 'tool-item-knowledge-base')).toBeFalsy();
  });
});

/**
 * A tool enabled while its key was present keeps its stored preference after the key
 * goes away, so it restores when a valid key returns. Until then it must not READ as
 * enabled: greyed-out-but-on is a control that claims to be usable while refusing to
 * be used, and the pinned tallies agree with it.
 *
 * Switches are found by their authored `.tool-item-*` class rather than getByRole:
 * the Fun & Novelty grid renders with `display: none` (the useUserSettings mock omits
 * `showFunTools`), which excludes it from the a11y tree.
 */
describe('ToolsSection unavailable-tool display', () => {
  const switchFor = (container: HTMLElement, toolClass: string) =>
    container.querySelector(`.${toolClass} [role="switch"]`);
  const tallyFor = (container: HTMLElement, section: string) =>
    Array.from(container.querySelectorAll('.tools-collapsible-title')).find(el => el.textContent?.startsWith(section))
      ?.textContent;
  const setToolsPayloads = () =>
    mocks.useLLM.setState.mock.calls.filter((call: unknown[]) => {
      const payload = call[0];
      return !!payload && typeof payload === 'object' && 'tools' in payload;
    });

  it('renders an unavailable tool off and drops it from the pinned tally', () => {
    mocks.state.tools = ['web_search', 'math_evaluate'];
    mocks.toolAvailability.value = { web_search: false };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(switchFor(container, 'tool-item-web-search')?.getAttribute('aria-checked')).toBe('false');
    expect(switchFor(container, 'tool-item-math')?.getAttribute('aria-checked')).toBe('true');
    expect(tallyFor(container, 'Individual tools')).toBe('Individual tools (1 pinned)');
  });

  // Control: proves the assertion above tracks availability rather than always reading off.
  it('leaves the switch on and counted when the key is present', () => {
    mocks.state.tools = ['web_search', 'math_evaluate'];
    mocks.toolAvailability.value = { web_search: true };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(switchFor(container, 'tool-item-web-search')?.getAttribute('aria-checked')).toBe('true');
    expect(tallyFor(container, 'Individual tools')).toBe('Individual tools (2 pinned)');
  });

  // Control against an over-fix (`=== true`): availability is undefined until
  // /serverConfig resolves, and treating that as missing would blank the panel on
  // first paint.
  it('leaves everything on while availability is still loading', () => {
    mocks.state.tools = ['web_search'];
    mocks.toolAvailability.value = undefined;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(switchFor(container, 'tool-item-web-search')?.getAttribute('aria-checked')).toBe('true');
    expect(tallyFor(container, 'Individual tools')).toBe('Individual tools (1 pinned)');
  });

  // The tally is `pinnedCount > 0 ? ... : ''`, so zero renders no parenthetical at all
  // rather than "(0 pinned)".
  it('renders no tally when the only enabled tool is unavailable', () => {
    mocks.state.tools = ['web_search'];
    mocks.toolAvailability.value = { web_search: false };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(tallyFor(container, 'Individual tools')).toBe('Individual tools');
  });

  it('drops an unavailable Fun tool from the Fun tally without disturbing Individual tools', () => {
    mocks.state.tools = ['weather_info', 'math_evaluate'];
    mocks.toolAvailability.value = { weather_info: false };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(switchFor(container, 'tool-item-weather')?.getAttribute('aria-checked')).toBe('false');
    expect(tallyFor(container, 'Fun & Novelty')).toBe('Fun & Novelty');
    expect(tallyFor(container, 'Individual tools')).toBe('Individual tools (1 pinned)');
  });

  // Mode gating dims a row without contradicting it: the preference is still honored
  // the moment the mode changes, so the switch must stay on. Only a missing key -
  // which nothing the user does in this panel can fix - reads as off. Fast mode is
  // the only mode gate left; the Agent-mode twin of this test went away with the
  // Agent-mode dimming itself.
  it('does not flip a switch for Fast-mode dimming', () => {
    mocks.state.tools = ['web_search'];
    mocks.state.toolMode = 'fast';
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(gated(container, 'tool-item-web-search')).toBeTruthy();
    expect(switchFor(container, 'tool-item-web-search')?.getAttribute('aria-checked')).toBe('true');
    expect(tallyFor(container, 'Individual tools')).toBe('Individual tools (1 pinned)');
  });

  it('keeps the stored preference for an unavailable tool', () => {
    mocks.adminFeatureFlags.value = { EnableKnowledgeBaseSearch: true };
    mocks.state.tools = ['search_knowledge_base'];
    mocks.toolAvailability.value = { search_knowledge_base: false };
    render(<ToolsSection />, { wrapper: Wrapper });
    expect(mocks.state.tools).toContain('search_knowledge_base');
    expect(setToolsPayloads()).toHaveLength(0);
  });

  // ToolContainer only kills pointer events, so the greyed switch stays a focusable
  // button. Without a guard in handleToggleTool, Enter/Space would erase the stored
  // preference while the switch already reads off - a silent edit with no feedback.
  it('refuses to toggle a key-gated switch', () => {
    mocks.adminFeatureFlags.value = { EnableKnowledgeBaseSearch: true };
    mocks.state.tools = ['search_knowledge_base'];
    mocks.toolAvailability.value = { search_knowledge_base: false };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(switchFor(container, 'tool-item-knowledge-base') as Element);
    expect(setToolsPayloads()).toHaveLength(0);
  });

  // Control: the same click DOES reach handleToggleTool once the key is present, so
  // the assertion above is about the guard and not about an unclickable element.
  it('still toggles that switch when the key is present', () => {
    mocks.adminFeatureFlags.value = { EnableKnowledgeBaseSearch: true };
    mocks.state.tools = ['search_knowledge_base'];
    mocks.toolAvailability.value = { search_knowledge_base: true };
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(switchFor(container, 'tool-item-knowledge-base') as Element);
    expect(setToolsPayloads()).toEqual([[{ tools: [] }]]);
  });
});

// LOCK-STEP with computeToolAvailability in pages/api/settings/serverConfig.ts: web_search and
// deep_research now resolve through the SearXNG/Firecrawl providers, so their disabled-tooltips must
// name those alternatives (not just Serper/Firecrawl keys).
describe('MISSING_KEY_TOOLTIPS lock-step wording', () => {
  it('names the SearXNG and Firecrawl alternatives', () => {
    expect(MISSING_KEY_TOOLTIPS.web_search).toContain('SearXNG');
    expect(MISSING_KEY_TOOLTIPS.web_search).toContain('Serper');
    expect(MISSING_KEY_TOOLTIPS.deep_research).toContain('SearXNG');
    expect(MISSING_KEY_TOOLTIPS.deep_research).toContain('Firecrawl');
  });

  it('names the local Ollama embedder alternative for the knowledge base', () => {
    expect(MISSING_KEY_TOOLTIPS.search_knowledge_base).toContain('OLLAMA_BASE_URL');
  });
});
