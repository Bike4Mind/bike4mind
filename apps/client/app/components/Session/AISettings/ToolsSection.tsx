import SupportsToolsIcon from '@client/app/components/svgs/SupportsToolsIcon';
import {
  AutoAwesome as AutoAwesomeIcon,
  Compare as CompareIcon,
  Language as LanguageIcon,
  Schedule as DateTimeIcon,
  Casino as DiceIcon,
  Image as ImageIcon,
  Calculate as MathIcon,
  Schema as MermaidIcon,
  Search as SearchIcon,
  Science as ScienceIcon,
  WbSunny as WeatherIcon,
  AutoFixHigh as PromptEnhancementIcon,
  BarChart as RechartsIcon,
  Settings as SettingsIcon,
  HdrAuto as AtlassianIcon,
  History as HistoryIcon,
  NightsStay as MoonIcon,
  WbTwilight as SunriseIcon,
  Satellite as SatelliteIcon,
  Explore as PlanetIcon,
  GridView as LatticeIcon,
  FolderOpen as KnowledgeBaseIcon,
  Extension as ChessIcon,
  ExpandMore as ExpandMoreIcon,
  Functions as WolframIcon,
  TableChart as ExcelIcon,
  ShowChart as FinanceIcon,
} from '@mui/icons-material';
import { Box, Grid, Input, Tooltip, Typography, IconButton } from '@mui/joy';
import type { BoxProps } from '@mui/joy';
import SwitchSelector from '@client/app/components/common/fields/SwitchSelector';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { PropsWithChildren, useEffect, useMemo, useState, useCallback, createContext, useContext } from 'react';
import { B4MLLMTools, IMcpServerDocument, classifyQueryComplexity } from '@bike4mind/common';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useTheme } from '@mui/joy';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useAdvancedAISettings } from '@client/app/components/Session/AdvancedAISettings';
import { commandHandlers } from '@client/app/components/Session/SessionBottom/sessionBottomConstants';
import { isImageModel, isVideoModel, type CommandKey } from '@client/app/utils/commands';
import { green } from '@client/app/utils/themes/colors';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import DeepResearchConfigModal from './DeepResearchConfigModal';
import ImageGenerationModelSelectionModal from './ImageGenerationModelSelectionModal';
import { getToolDisplayName, getToolDescription, isToolAvailableInAgentMode } from '@client/app/utils/toolMapping';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useConfig } from '@client/app/hooks/data/settings';

/**
 * Tooltip shown when a tool is disabled because its required API key/config is
 * missing on the server. Keyed by tool id; only tools that need external config
 * appear here (availability comes from serverConfig.toolAvailability).
 *
 * LOCK-STEP: the keys here must mirror those returned by `computeToolAvailability`
 * in `apps/client/pages/api/settings/serverConfig.ts`. When you gate a new tool
 * there, add its tooltip here (a gated tool with no entry falls back to a generic
 * "Requires an API key that has not been configured." message).
 */
const MISSING_KEY_TOOLTIPS: Partial<Record<B4MLLMTools, string>> = {
  web_search: 'Requires a Serper API key or a local SearXNG URL, configured in Admin > API Keys.',
  deep_research: 'Requires a Firecrawl API key, configured in Admin > API Keys.',
  weather_info: 'Requires an OpenWeather API key, configured in Admin > API Keys.',
  wolfram_alpha: 'Requires a Wolfram Alpha API key, configured in Admin > API Keys.',
  fmp_financial_data: 'Requires an FMP API key, configured in Admin > API Keys.',
  image_generation: 'Requires an image generation API key (e.g. BFL or OpenAI), configured in Admin > API Keys.',
  search_knowledge_base: 'Requires an embeddings API key (VoyageAI or OpenAI), configured in Admin > API Keys.',
};

type McpServerOption = Pick<IMcpServerDocument, 'id' | 'enabled' | 'tools'> & { name: string };

/**
 * Resolves, for a given tool id, why it's unavailable in the current composer
 * mode (Fast / Agent), or `null` when the tool is allowed. Provided by
 * ToolsSection so each ToolContainer can dim itself + show an explanatory
 * tooltip without prop-drilling the mode state to every row.
 */
type ToolGate = { reason: string } | null;
const ToolGateContext = createContext<(toolId: B4MLLMTools) => ToolGate>(() => null);

interface ToolContainerProps extends PropsWithChildren {
  sx?: BoxProps['sx'];
  /**
   * When set, this row represents a Smart Tool whose availability depends on the
   * current mode. If the mode disallows it, the row is dimmed + made
   * non-interactive and wrapped in a tooltip explaining why. Omit for non-tool
   * rows (Thinking, Quest Master, MCP servers, etc.) which are never mode-gated.
   */
  toolId?: B4MLLMTools;
}

const ToolContainer = ({ children, sx, toolId }: ToolContainerProps) => {
  const getToolGate = useContext(ToolGateContext);
  const gate = toolId ? getToolGate(toolId) : null;

  const content = (
    <Box
      className="tool-container"
      sx={theme => {
        const baseStyles = {
          backgroundColor: () =>
            theme.palette.mode === 'light' ? theme.palette.background.surface2 : theme.palette.background.body,
          borderRadius: 5,
          display: 'flex',
          alignItems: 'center',
          p: '8px',
          gap: 2,
          '&:hover': {
            bgcolor: theme.palette.notebooklist.hoverBg,
          },
          transition: 'background-color 0.2s',
          border: 'none',
        };

        if (!sx) {
          return baseStyles;
        }

        const overrideStyles = typeof sx === 'function' ? sx(theme) : sx;
        return { ...baseStyles, ...overrideStyles };
      }}
    >
      {children}
    </Box>
  );

  if (!gate) {
    return content;
  }

  // Disallowed in the current mode: dim + disable interaction on the row itself,
  // but keep the wrapper hoverable so the explanatory tooltip still shows.
  return (
    <Tooltip title={gate.reason} variant="soft" size="sm" placement="top" arrow>
      <Box
        aria-disabled
        data-tool-disabled="true"
        sx={{ width: '100%', opacity: 0.45, '& .tool-container': { pointerEvents: 'none' } }}
      >
        {content}
      </Box>
    </Tooltip>
  );
};

interface ToolLabelProps {
  name: string;
  description: string;
  dim?: boolean;
}

// Two-line label (name + inline description) used in place of the old
// name-plus-(i)-tooltip pattern, so users can read what a tool does without hovering.
const ToolLabel = ({ name, description, dim = false }: ToolLabelProps) => (
  <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
    <Typography
      level="body-sm"
      noWrap
      sx={{
        color: theme => (dim ? theme.palette.text.secondary : theme.palette.text.primary),
        lineHeight: 1.2,
      }}
    >
      {name}
    </Typography>
    <Typography
      level="body-xs"
      sx={{
        color: 'text.tertiary',
        fontSize: '0.7rem',
        lineHeight: 1.3,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
    >
      {description}
    </Typography>
  </Box>
);

interface ToolsSectionProps {
  tools?: B4MLLMTools[];
  setTools?: (tools: B4MLLMTools[]) => void;
  model?: string;
  onRollDice?: () => void;
  columns?: number;
  onModalOpenChange?: (isOpen: boolean) => void;
  toolContainerSx?: BoxProps['sx'];
}

const ToolsSection = ({
  tools: propTools,
  setTools,
  columns = 2,
  onModalOpenChange,
  toolContainerSx,
}: ToolsSectionProps = {}) => {
  // Use props if provided, otherwise use context
  const contextTools = useLLM(state => state.tools);
  const toolMode = useLLM(state => state.toolMode);
  const isQuestMasterEnabled = useLLM(state => state.isQuestMasterEnabled);
  const isAgentsEnabled = useLLM(state => state.isAgentsEnabled);
  const agentMode = useLLM(state => state.agentMode);
  const isLatticeEnabled = useLLM(state => state.isLatticeEnabled);
  const researchMode = useLLM(state => state.researchMode);
  const enabledMcpServers = useLLM(state => state.enabledMcpServers);
  const { setState: setLLM } = useLLM;
  const { settings: userSettings, updatePreferences } = useUserSettings();
  const showIndividualTools = !userSettings.toolsCatalogCollapsed;
  const showFunTools = userSettings.showFunTools;
  const {
    data: mcpServersData = [],
    isPending: isLoadingMcpServers,
    isFetching: isFetchingMcpServers,
  } = useMcpServers();

  const { isFeatureEnabled: checkFeatureEnabled, isAdminFeatureEnabled } = useFeatureEnabled();
  const isQuestMasterFeatureEnabled = checkFeatureEnabled('enableQuestMaster');
  const isAgentsFeatureEnabled = checkFeatureEnabled('enableAgents');
  const isLatticeFeatureEnabled = checkFeatureEnabled('enableLattice');
  const isResearchModeFeatureEnabled = checkFeatureEnabled('enableResearchMode');
  const isDeepResearchEnabled = isAdminFeatureEnabled('EnableDeepResearch');
  const isKnowledgeBaseSearchEnabled = isAdminFeatureEnabled('EnableKnowledgeBaseSearch');
  const isFmpFinancialDataEnabled = isAdminFeatureEnabled('EnableFmpFinancialData');
  // Presence-only availability of key-gated tools (no key values leak to the client).
  const { data: serverConfig } = useConfig();
  const toolAvailability = serverConfig?.toolAvailability;
  const tools = propTools ?? contextTools;
  const theme = useTheme();
  const model = useLLM(s => s.model);
  const { data: modelInfoRepo } = useModelInfo();
  const modelInfo = useMemo(() => modelInfoRepo?.find(m => m.id === model), [model, modelInfoRepo]);

  const [deepResearchConfigOpen, setDeepResearchConfigOpen] = useState(false);
  const [imageGenModelSelectionOpen, setImageGenModelSelectionOpen] = useState(false);

  const thinking = useLLM(state => state.thinking);

  const toggleCatalogCollapsed = useCallback(() => {
    updatePreferences({ toolsCatalogCollapsed: !userSettings.toolsCatalogCollapsed });
  }, [updatePreferences, userSettings.toolsCatalogCollapsed]);

  const toggleFunTools = useCallback(() => {
    updatePreferences({ showFunTools: !userSettings.showFunTools });
  }, [updatePreferences, userSettings.showFunTools]);

  // Notify parent when modal opens/closes
  useEffect(() => {
    onModalOpenChange?.(deepResearchConfigOpen || imageGenModelSelectionOpen);
  }, [deepResearchConfigOpen, imageGenModelSelectionOpen, onModalOpenChange]);

  // Check if the current model supports thinking
  const modelSupportsThinking = useMemo(() => {
    return modelInfo?.can_think === true;
  }, [modelInfo?.can_think]);

  const availableMcpServers = useMemo(
    () => mcpServersData.filter((server: IMcpServerDocument) => server.enabled !== false),
    [mcpServersData]
  );

  const visibleMcpServers = useMemo<McpServerOption[]>(() => {
    const normalizedMap = new Map<string, McpServerOption>();

    // Always show all servers from database (these are the installed/configured MCP servers)
    availableMcpServers.forEach(server => {
      normalizedMap.set(server.name.toLowerCase(), {
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        tools: server.tools,
      });
    });

    // IMPORTANT: Show servers even when unchecked
    // This ensures toggles don't disappear when disabled
    // We check enabledMcpServers to maintain backwards compatibility
    if (Array.isArray(enabledMcpServers)) {
      enabledMcpServers.forEach(name => {
        const key = name.toLowerCase();
        if (!normalizedMap.has(key)) {
          normalizedMap.set(key, {
            id: key,
            name,
            enabled: true,
            tools: [],
          });
        }
      });
    }

    return Array.from(normalizedMap.values());
  }, [availableMcpServers, enabledMcpServers]);

  const showMcpLoadingState = (isLoadingMcpServers || isFetchingMcpServers) && visibleMcpServers.length === 0;

  // Note: Initialization and cleanup are handled by SessionBottom.tsx
  // to ensure MCP works without opening Tools panel

  const isMcpServerEnabled = (serverName: string) => {
    if (enabledMcpServers === null) {
      return true;
    }
    return enabledMcpServers.includes(serverName);
  };

  const toggleMcpServer = (serverName: string) => {
    const baseline = enabledMcpServers ?? visibleMcpServers.map(server => server.name);
    const currentlyEnabled = baseline.includes(serverName);
    const next = currentlyEnabled ? baseline.filter(name => name !== serverName) : [...baseline, serverName];
    setLLM({ enabledMcpServers: next });
  };

  const getMcpServerLabel = (serverName: string) => {
    switch (serverName) {
      case 'atlassian':
        return 'Atlassian Tools';
      default:
        return `${serverName.charAt(0).toUpperCase()}${serverName.slice(1)} Tools`;
    }
  };

  const getMcpServerDescription = (serverName: string) => {
    switch (serverName) {
      case 'atlassian':
        return 'Search Confluence pages and Jira issues; view project information';
      default:
        return 'External MCP server integration';
    }
  };

  const commonInputStyles = {
    width: '6rem',
    '& input[type=number]::-webkit-inner-spin-button, & input[type=number]::-webkit-outer-spin-button': {
      opacity: 1,
      marginRight: '-1px',
    },
    '& input': {
      textAlign: 'center',
    },
    borderRadius: 6,
    border: 'none',
    // any: MUI Joy custom palette extension (aiSettings) lacks exported type
    backgroundColor: (theme: any) => theme.palette.aiSettings.inputBackground,
    color: 'text.primary',
  };

  const handleToggleTool = useCallback(
    (tool: B4MLLMTools) => {
      if (setTools) {
        // Use the provided setTools function
        if (tools.includes(tool)) {
          setTools(tools.filter(t => t !== tool));
        } else {
          setTools([...tools, tool]);
        }
      } else {
        // Fall back to context
        setLLM({
          tools: tools.includes(tool) ? tools.filter(t => t !== tool) : [...tools, tool],
        });
      }
    },
    [setLLM, setTools, tools]
  );

  // Agent mode runs the agent executor (fixed toolset, ignoring Smart Tools) when
  // the composer bolt is ON and the feature is available. Mirrors the real routing
  // gate in useSendMessage (`agentToggleActive` = isFeatureEnabled('agentMode') &&
  // agentMode.enabled && !isRealSlashCommand), so it must use the RESOLVED feature
  // flag (checkFeatureEnabled, which honors the admin EnableAgentModeDefault), NOT
  // the raw experimentalFeatures.agentMode pref: an account enabled via the admin
  // default has a working bolt but an unset raw pref, so keying on the raw pref
  // left the bolt visibly ON yet the tools ungreyed. This is NOT enableAgents /
  // isAgentsEnabled (the unrelated "@help Agent Detection" feature); gating on that
  // would no-op the dimming for dogfooders with agentMode on but enableAgents off.
  const agentModeActive = checkFeatureEnabled('agentMode') && (agentMode?.enabled ?? false);

  // Predict whether the CURRENT draft prompt would silently auto-route to the
  // agent via the rule-based complexity path (mirrors `autoRouteEnabled &&
  // complexity === 'complex'` in routeQuery). When it would, the agent runs its
  // fixed toolset and ignores the user's Smart Tools, so we grey the ignored
  // tools here, BEFORE send, exactly like the explicit-toggle dimming. The LLM
  // intent-classifier's decision isn't knowable client-side (it only fires at
  // send), so this hint covers the rule-based complexity path only.
  const chatDraft = useChatInput(s => s.chatInputValue);
  const disableAutoRouteForThisSession = useLLM(s => s.disableAutoRouteForThisSession);
  // Mirrors the send path's `liveAI` flag - the send only injects a generation
  // command on image/video models when liveAI is on (see the image/video guard).
  const liveAI = useAdvancedAISettings(state => state.liveAI);
  const autoRouteEnabled = checkFeatureEnabled('agentMode') && userSettings.agentModeDefault === 'auto';
  const predictedComplexityRoute = useMemo(() => {
    if (!isAgentsEnabled || !autoRouteEnabled || disableAutoRouteForThisSession) return false;
    const draft = chatDraft?.trim();
    if (!draft) return false;
    // Real slash commands (e.g. `/gen_image ...`) run their own handler and
    // never auto-route, mirroring the `!isRealSlashCommand` gate in
    // useSendMessage. Skip the prediction for them so the panel doesn't grey
    // tools that will actually run. `/llm` is the implicit default, not a real
    // command, so it stays subject to auto-routing (matches useSendMessage).
    const firstToken = draft.split(/\s+/)[0];
    if (firstToken !== '/llm' && commandHandlers[firstToken as CommandKey] !== undefined) return false;
    // On image/video models the send path (extractCommandAndParams) injects
    // `/gen_image` / `/gen_video` for a non-command draft, turning it into a
    // real slash command that runs generation and never auto-routes. Mirror
    // that here so a plain complex-scoring draft on an image/video model isn't
    // greyed for a send that won't reroute. Gated on `liveAI` because the send
    // only injects when `liveAI && !startsWithCommand` (commands.ts) - with
    // liveAI off there's no injection, so a complex draft WOULD auto-route and
    // the tools should still grey. Uses the same isImageModel/isVideoModel
    // predicates the send path uses, keeping the two in lockstep.
    if (liveAI && (isImageModel(model) || isVideoModel(model))) return false;
    // Session file / agent context isn't available in this component, so those
    // args are passed empty - omitting them can only lower the score, never
    // raise it, so it won't grey spuriously on that account. (The tools /
    // researchMode signals ARE passed: an enabled forcing tool - recharts /
    // image_generation / deep_research / chess / research mode - makes
    // classifyQueryComplexity return 'complex' regardless of draft text, which
    // is correct and matches routeQuery, not an over-count bug.)
    //
    // Limitation: this prediction is draft-only and history-agnostic,
    // while the real send can decline to auto-route for session-state reasons
    // (e.g. `isAgentsEnabled` resolves false in a continued session after a
    // model switch). So the greying can occasionally over-predict on follow-up
    // messages - the copy says the request "may" auto-route rather than "will",
    // and the badge/normal-chat outcome is the source of truth.
    return classifyQueryComplexity(draft, [], [], tools, researchMode) === 'complex';
  }, [
    chatDraft,
    tools,
    researchMode,
    model,
    liveAI,
    isAgentsEnabled,
    autoRouteEnabled,
    disableAutoRouteForThisSession,
  ]);

  // The agent runs its fixed toolset (ignoring Smart Tools) when either the
  // explicit toggle is on OR the draft would auto-route on complexity.
  const agentWillRunFixedToolset = agentModeActive || predictedComplexityRoute;

  // Per-tool availability for the current mode. Fast mode uses no tools at all;
  // Agent mode honors only its fixed toolset. Smart mode allows everything.
  const getToolGate = useCallback(
    (toolId: B4MLLMTools): { reason: string } | null => {
      // A missing API key is a hard, mode-independent blocker: without it the
      // tool silently returns nothing, so surface it first. Only gate once the
      // availability data has loaded (=== false), never on undefined.
      if (toolAvailability?.[toolId] === false) {
        return { reason: MISSING_KEY_TOOLTIPS[toolId] ?? 'Requires an API key that has not been configured.' };
      }
      if (toolMode === 'fast') {
        return { reason: 'Disabled in Fast mode. Switch to Smart mode to let the AI use tools.' };
      }
      if (agentWillRunFixedToolset && !isToolAvailableInAgentMode(toolId)) {
        return {
          reason: agentModeActive
            ? 'Not available in Agent mode. Agent mode runs a fixed toolset and ignores this Smart Tool.'
            : 'This request may auto-route to Agent mode, which runs a fixed toolset that would ignore this Smart Tool.',
        };
      }
      return null;
    },
    [toolMode, agentWillRunFixedToolset, agentModeActive, toolAvailability]
  );

  const toggleQuestMaster = () => {
    setLLM({ isQuestMasterEnabled: !isQuestMasterEnabled });
  };

  const toggleAgents = () => {
    setLLM({ isAgentsEnabled: !isAgentsEnabled });
  };

  const toggleLattice = () => {
    setLLM({ isLatticeEnabled: !isLatticeEnabled });
  };

  // Todo: Turn off and hide other tools that are not supported by the other models
  useEffect(() => {
    if (!modelInfo?.supportsTools) {
      setLLM({ tools: [] });
    }
  }, [modelInfo?.supportsTools, setLLM]);

  // Disable thinking when switching to a non-thinking model
  useEffect(() => {
    if (!modelSupportsThinking && thinking?.enabled) {
      setLLM({
        thinking: {
          enabled: false,
          budget_tokens: thinking?.budget_tokens ?? 16000,
        },
      });
    }
  }, [modelSupportsThinking, thinking?.enabled, thinking?.budget_tokens, setLLM]);

  if (!modelInfo?.supportsTools) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          flex: 1,
          m: '-8px',
          p: '16px',
          width: 'auto',
          minWidth: 0,
        }}
      >
        <Typography level="body-sm" sx={{ color: 'text.primary', fontSize: '16px', whiteSpace: 'nowrap' }}>
          Selected AI model does not support tools
        </Typography>
      </Box>
    );
  }

  const pinnedCount = tools.length;

  return (
    <>
      {/* Top descriptor + help link */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
        <Typography
          level="body-xs"
          sx={{ color: 'text.secondary', flex: 1, lineHeight: 1.3 }}
          data-testid="smart-tools-descriptor"
        >
          Enable tools the AI can use during this conversation.
        </Typography>
        <ContextHelpButton
          helpId="features/smart-tools"
          tooltipText="Learn about Smart Tools"
          data-testid="help-button-smart-tools"
        />
      </Box>

      {/* Fast / Smart mode tabs */}
      <Box sx={{ mb: 0.5 }}>
        <SwitchSelector
          options={[
            { value: 'smart', label: 'Smart', tooltip: 'AI picks the right tools as needed' },
            { value: 'fast', label: 'Fast', tooltip: 'No tools — fastest possible response' },
          ]}
          value={toolMode}
          onChange={value => setLLM({ toolMode: value as 'fast' | 'smart' })}
          width="100%"
        />
      </Box>

      {/* Mode caption: explains what each mode does and resolves the Smart-mode toggle ambiguity */}
      <Typography
        level="body-xs"
        sx={{ color: 'text.secondary', mb: 1, lineHeight: 1.35 }}
        data-testid={`tool-mode-caption-${toolMode}`}
      >
        {toolMode === 'smart'
          ? agentWillRunFixedToolset
            ? agentModeActive
              ? 'Agent mode is on. It runs a fixed toolset; greyed-out Smart Tools below are ignored while Agent mode is active.'
              : 'This request may auto-route to Agent mode, which runs a fixed toolset. Greyed-out Smart Tools below would then be ignored.'
            : 'AI uses any enabled tools as needed. Toggle one off to disallow it.'
          : 'No tools are used. AI replies as quickly as possible.'}
      </Typography>

      {/* Collapsible individual tools header (default expanded; collapse state persisted per-user) */}
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={showIndividualTools}
        data-testid="tools-individual-toggle"
        onClick={toggleCatalogCollapsed}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCatalogCollapsed();
          }
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          py: 0.5,
          mb: showIndividualTools ? 1 : 0,
          userSelect: 'none',
          '&:hover': { opacity: 0.8 },
        }}
      >
        <ExpandMoreIcon
          sx={{
            fontSize: '1rem',
            transition: 'transform 0.2s',
            transform: showIndividualTools ? 'rotate(0deg)' : 'rotate(-90deg)',
            color: 'text.secondary',
            mr: 0.5,
          }}
        />
        <Typography level="body-xs" sx={{ color: 'text.secondary', flex: 1 }}>
          Individual tools{pinnedCount > 0 ? ` (${pinnedCount} pinned)` : ''}
        </Typography>
      </Box>

      {/* Tool grid (collapsible). Per-tool availability (Fast/Agent mode) is
          handled per row via ToolGateContext + ToolContainer's `toolId`, so the
          grid no longer dims as a whole; disallowed tools dim individually and
          carry a tooltip explaining the mode. */}
      <ToolGateContext.Provider value={getToolGate}>
        <Box
          className="tools-section-grid"
          sx={{
            display: showIndividualTools ? 'grid' : 'none',
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: columns,
            width: '100%',
            overflow: { xs: 'auto', sm: 'initial' },
          }}
        >
          {/* Web Search */}
          <Grid xs={12} className="tool-item tool-item-web-search">
            <ToolContainer sx={toolContainerSx} toolId="web_search">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <SearchIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel name={getToolDisplayName('web_search')} description={getToolDescription('web_search')} />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('web_search')}
                checked={tools.includes('web_search')}
              />
            </ToolContainer>
          </Grid>
          {/* Web Fetch */}
          <Grid xs={12} className="tool-item tool-item-web-fetch">
            <ToolContainer sx={toolContainerSx} toolId="web_fetch">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <LanguageIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel name={getToolDisplayName('web_fetch')} description={getToolDescription('web_fetch')} />
              </Box>
              <SquareSlideToggle onChange={() => handleToggleTool('web_fetch')} checked={tools.includes('web_fetch')} />
            </ToolContainer>
          </Grid>
          {/* Knowledge Base Search */}
          {isKnowledgeBaseSearchEnabled && (
            <Grid xs={12} className="tool-item tool-item-knowledge-base">
              <ToolContainer sx={toolContainerSx} toolId="search_knowledge_base">
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <KnowledgeBaseIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <ToolLabel
                    name={getToolDisplayName('search_knowledge_base')}
                    description={getToolDescription('search_knowledge_base')}
                  />
                </Box>
                <SquareSlideToggle
                  onChange={() => handleToggleTool('search_knowledge_base')}
                  checked={tools.includes('search_knowledge_base')}
                />
              </ToolContainer>
            </Grid>
          )}
          {/* Financial Data (FMP) */}
          {isFmpFinancialDataEnabled && (
            <Grid xs={12} className="tool-item tool-item-fmp-financial-data">
              <ToolContainer sx={toolContainerSx} toolId="fmp_financial_data">
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <FinanceIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <ToolLabel
                    name={getToolDisplayName('fmp_financial_data')}
                    description={getToolDescription('fmp_financial_data')}
                  />
                </Box>
                <SquareSlideToggle
                  onChange={() => handleToggleTool('fmp_financial_data')}
                  checked={tools.includes('fmp_financial_data')}
                />
              </ToolContainer>
            </Grid>
          )}
          {showMcpLoadingState && (
            <Grid xs={12} className="tool-item tool-item-mcp-loading">
              <ToolContainer sx={toolContainerSx}>
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <SearchIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <Typography level="body-sm" noWrap sx={{ color: theme => theme.palette.text.primary }}>
                    Loading workspace integrations…
                  </Typography>
                </Box>
                <SquareSlideToggle disabled checked={false} onChange={() => {}} />
              </ToolContainer>
            </Grid>
          )}
          {visibleMcpServers.map(server => (
            <Grid xs={12} key={server.id ?? server.name} className={`tool-item tool-item-mcp-${server.name}`}>
              <ToolContainer sx={toolContainerSx}>
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  {server.name === 'atlassian' ? (
                    <AtlassianIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                  ) : (
                    <SettingsIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                  )}
                  <ToolLabel name={getMcpServerLabel(server.name)} description={getMcpServerDescription(server.name)} />
                </Box>
                <SquareSlideToggle
                  onChange={() => toggleMcpServer(server.name)}
                  checked={isMcpServerEnabled(server.name)}
                />
              </ToolContainer>
            </Grid>
          ))}
          {/* Prompt Enhancement */}
          <Grid xs={12} className="tool-item tool-item-prompt-enhancement">
            <ToolContainer sx={toolContainerSx} toolId="prompt_enhancement">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <PromptEnhancementIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('prompt_enhancement')}
                  description={getToolDescription('prompt_enhancement')}
                />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('prompt_enhancement')}
                checked={tools.includes('prompt_enhancement')}
              />
            </ToolContainer>
          </Grid>
          {/* Deep Research */}
          {isDeepResearchEnabled && (
            <Grid xs={12} className="tool-item tool-item-deep-research">
              <ToolContainer sx={toolContainerSx} toolId="deep_research">
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <ScienceIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <ToolLabel
                    name={getToolDisplayName('deep_research')}
                    description={getToolDescription('deep_research')}
                  />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Tooltip title="Configure deep research settings">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      onMouseDown={e => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDeepResearchConfigOpen(true);
                      }}
                      sx={{
                        minWidth: 'auto',
                        minHeight: 'auto',
                        '--IconButton-size': '28px',
                        '&:hover': {
                          backgroundColor: 'transparent',
                        },
                      }}
                    >
                      <SettingsIcon
                        sx={{
                          fontSize: '20px',
                          color: theme => `${theme.palette.text.primary}80`,
                          marginRight: '4px',
                          '&:hover': {
                            color: theme => theme.palette.text.primary,
                          },
                        }}
                      />
                    </IconButton>
                  </Tooltip>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('deep_research')}
                    checked={tools.includes('deep_research')}
                  />
                </Box>
              </ToolContainer>
            </Grid>
          )}
          {/* Image Generation */}
          <Grid xs={12} className="tool-item tool-item-image-generation">
            <ToolContainer sx={toolContainerSx} toolId="image_generation">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <ImageIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('image_generation')}
                  description={getToolDescription('image_generation')}
                />
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Tooltip title="Select image generation model">
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="neutral"
                    data-testid="image-generation-settings-btn"
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setImageGenModelSelectionOpen(true);
                    }}
                    sx={{
                      minWidth: 'auto',
                      minHeight: 'auto',
                      '--IconButton-size': '28px',
                      '&:hover': {
                        backgroundColor: 'transparent',
                      },
                    }}
                  >
                    <SettingsIcon
                      sx={{
                        fontSize: '20px',
                        color: theme => `${theme.palette.text.primary}80`,
                        marginRight: '4px',
                        '&:hover': {
                          color: theme => theme.palette.text.primary,
                        },
                      }}
                    />
                  </IconButton>
                </Tooltip>
                <SquareSlideToggle
                  onChange={() => handleToggleTool('image_generation')}
                  checked={tools.includes('image_generation')}
                  data-testid="tool-toggle-image-generation"
                />
              </Box>
            </ToolContainer>
          </Grid>
          {/* Mermaid Chart */}
          <Grid xs={12} className="tool-item tool-item-mermaid-chart">
            <ToolContainer sx={toolContainerSx} toolId="mermaid_chart">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <MermaidIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('mermaid_chart')}
                  description={getToolDescription('mermaid_chart')}
                />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('mermaid_chart')}
                checked={tools.includes('mermaid_chart')}
              />
            </ToolContainer>
          </Grid>
          {/* Excel Generator */}
          <Grid xs={12} className="tool-item tool-item-excel-generation">
            <ToolContainer sx={toolContainerSx} toolId="excel_generation">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <ExcelIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('excel_generation')}
                  description={getToolDescription('excel_generation')}
                />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('excel_generation')}
                checked={tools.includes('excel_generation')}
              />
            </ToolContainer>
          </Grid>
          <Grid xs={12} className="tool-item tool-item-thinking">
            <ToolContainer sx={toolContainerSx}>
              <Box
                className="tool-content"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  flex: 1,
                  minWidth: 0,
                  opacity: modelSupportsThinking ? 1 : 0.5,
                }}
              >
                <SupportsToolsIcon
                  width={25}
                  height={25}
                  opacity={modelSupportsThinking ? 0.5 : 0.3}
                  fill={`${theme.palette.text.primary}`}
                />
                <ToolLabel
                  name="Thinking"
                  description={
                    modelSupportsThinking
                      ? 'Reasons step-by-step before responding; tune the token budget for longer chains'
                      : 'Not supported by the selected model'
                  }
                  dim={!modelSupportsThinking}
                />
              </Box>
              {(thinking?.enabled ?? true) && modelSupportsThinking && (
                <Tooltip title="Number of tokens allocated for thinking">
                  <Input
                    sx={commonInputStyles}
                    size="sm"
                    variant="outlined"
                    color="primary"
                    type="number"
                    value={thinking?.budget_tokens ?? 16000}
                    onChange={e => {
                      const newValue = parseInt(e.target.value);
                      if (newValue >= 1000 && newValue <= 32000) {
                        setLLM({
                          thinking: {
                            enabled: thinking?.enabled ?? true,
                            budget_tokens: newValue,
                          },
                        });
                      }
                    }}
                    slotProps={{
                      input: {
                        min: 1000,
                        max: 32000,
                        step: 1000,
                      },
                    }}
                  />
                </Tooltip>
              )}
              <SquareSlideToggle
                onChange={e =>
                  setLLM({
                    thinking: {
                      enabled: e.target.checked,
                      budget_tokens: thinking?.budget_tokens ?? 16000,
                    },
                  })
                }
                checked={thinking?.enabled ?? false}
                disabled={!modelSupportsThinking}
              />
            </ToolContainer>
          </Grid>
          {/* Quest Master */}
          {isQuestMasterFeatureEnabled && (
            <Grid xs={12} className="tool-item tool-item-quest-master">
              <ToolContainer sx={toolContainerSx}>
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <AutoAwesomeIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <Box className="tool-info" sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    <ToolLabel
                      name="Quest Master"
                      description="Generates a structured plan for your request; auto-disables after"
                    />
                    {isQuestMasterEnabled && (
                      <Typography level="body-xs" sx={{ color: green[800], fontSize: '0.7rem', fontWeight: 500 }}>
                        Will create plan for next prompt
                      </Typography>
                    )}
                  </Box>
                </Box>
                <SquareSlideToggle onChange={toggleQuestMaster} checked={isQuestMasterEnabled} />
              </ToolContainer>
            </Grid>
          )}
          {/* Agent Detection */}
          {isAgentsFeatureEnabled && (
            <Grid xs={12} className="tool-item tool-item-agent-detection">
              <ToolContainer sx={toolContainerSx}>
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <AutoAwesomeIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <ToolLabel
                    name="Agent Detection (@help)"
                    description="Suggests specialized agents; mention @help to trigger suggestions"
                  />
                </Box>
                <SquareSlideToggle onChange={toggleAgents} checked={isAgentsEnabled} />
              </ToolContainer>
            </Grid>
          )}
          {/* Lattice - Financial Pro-Forma Models */}
          {isLatticeFeatureEnabled && (
            <Grid xs={12} className="tool-item tool-item-lattice">
              <ToolContainer sx={toolContainerSx}>
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <LatticeIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <ToolLabel
                    name="Lattice"
                    description="Build financial pro-forma models in natural language, spreadsheet-style"
                  />
                </Box>
                <SquareSlideToggle
                  onChange={toggleLattice}
                  checked={isLatticeEnabled}
                  data-testid="tool-toggle-lattice"
                />
              </ToolContainer>
            </Grid>
          )}
          {/* Current Date/Time */}
          <Grid xs={12} className="tool-item tool-item-datetime">
            <ToolContainer sx={toolContainerSx} toolId="current_datetime">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <DateTimeIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('current_datetime')}
                  description={getToolDescription('current_datetime')}
                />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('current_datetime')}
                checked={tools.includes('current_datetime')}
              />
            </ToolContainer>
          </Grid>
          {/* Math Evaluate */}
          <Grid xs={12} className="tool-item tool-item-math">
            <ToolContainer sx={toolContainerSx} toolId="math_evaluate">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <MathIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('math_evaluate')}
                  description={getToolDescription('math_evaluate')}
                />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('math_evaluate')}
                checked={tools.includes('math_evaluate')}
              />
            </ToolContainer>
          </Grid>
          {/* Wolfram Alpha */}
          <Grid xs={12} className="tool-item tool-item-wolfram-alpha">
            <ToolContainer sx={toolContainerSx} toolId="wolfram_alpha">
              <Box
                className="tool-content"
                sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
              >
                <WolframIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <ToolLabel
                  name={getToolDisplayName('wolfram_alpha')}
                  description={getToolDescription('wolfram_alpha')}
                />
              </Box>
              <SquareSlideToggle
                onChange={() => handleToggleTool('wolfram_alpha')}
                checked={tools.includes('wolfram_alpha')}
              />
            </ToolContainer>
          </Grid>
          {/* Research Mode */}
          {isResearchModeFeatureEnabled && (
            <Grid xs={12} className="tool-item tool-item-research-mode">
              <ToolContainer sx={toolContainerSx}>
                <Box
                  className="tool-content"
                  sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                >
                  <CompareIcon
                    sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                  />
                  <ToolLabel
                    name="Research Mode"
                    description="Gathers info from multiple sources for thorough, well-researched answers"
                  />
                </Box>
                <SquareSlideToggle
                  onChange={e => setLLM({ researchMode: { ...researchMode, enabled: e.target.checked } })}
                  checked={researchMode.enabled}
                />
              </ToolContainer>
            </Grid>
          )}
          {/* Recharts */}
          <Grid xs={12}>
            <ToolContainer sx={toolContainerSx} toolId="recharts">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                <RechartsIcon
                  sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minWidth: 0 }}>
                  <ToolLabel name={getToolDisplayName('recharts')} description={getToolDescription('recharts')} />
                  {tools.includes('recharts') && (
                    <SwitchSelector
                      options={[
                        { value: 'inline', label: 'Inline' },
                        ...(checkFeatureEnabled('enableArtifacts') ? [{ value: 'artifact', label: 'Artifact' }] : []),
                      ]}
                      value={userSettings.rechartsDisplayMode || 'inline'}
                      onChange={newDisplayMode => {
                        updatePreferences({ rechartsDisplayMode: newDisplayMode as 'inline' | 'artifact' });

                        // Trigger a global event for recharts display mode change
                        window.dispatchEvent(
                          new CustomEvent('rechartsDisplayModeChanged', {
                            detail: { displayMode: newDisplayMode },
                          })
                        );
                      }}
                      width="140px"
                    />
                  )}
                </Box>
                <SquareSlideToggle onChange={() => handleToggleTool('recharts')} checked={tools.includes('recharts')} />
              </Box>
            </ToolContainer>
          </Grid>
        </Box>
      </ToolGateContext.Provider>

      {/* Collapsible Fun & Novelty tools section (hidden by default for FTUE) */}
      {showIndividualTools && (
        <>
          <Box
            role="button"
            tabIndex={0}
            aria-expanded={showFunTools}
            data-testid="tools-fun-toggle"
            onClick={toggleFunTools}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleFunTools();
              }
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              py: 0.5,
              mt: 1,
              mb: showFunTools ? 1 : 0,
              userSelect: 'none',
              '&:hover': { opacity: 0.8 },
            }}
          >
            <ExpandMoreIcon
              sx={{
                fontSize: '1rem',
                transition: 'transform 0.2s',
                transform: showFunTools ? 'rotate(0deg)' : 'rotate(-90deg)',
                color: 'text.secondary',
                mr: 0.5,
              }}
            />
            <Typography level="body-xs" sx={{ color: 'text.secondary', flex: 1 }}>
              Fun & Novelty
            </Typography>
          </Box>

          <ToolGateContext.Provider value={getToolGate}>
            <Box
              className="tools-section-fun-grid"
              sx={{
                display: showFunTools ? 'grid' : 'none',
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: columns,
                width: '100%',
                overflow: { xs: 'auto', sm: 'initial' },
              }}
            >
              {/* Chess Engine */}
              <Grid xs={12} className="tool-item tool-item-chess-engine">
                <ToolContainer sx={toolContainerSx} toolId="chess_engine">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <ChessIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel
                      name={getToolDisplayName('chess_engine')}
                      description={getToolDescription('chess_engine')}
                    />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('chess_engine')}
                    checked={tools.includes('chess_engine')}
                  />
                </ToolContainer>
              </Grid>
              {/* Dice Roll */}
              <Grid xs={12} className="tool-item tool-item-dice">
                <ToolContainer sx={toolContainerSx} toolId="dice_roll">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <DiceIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel name={getToolDisplayName('dice_roll')} description={getToolDescription('dice_roll')} />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('dice_roll')}
                    checked={tools.includes('dice_roll')}
                  />
                </ToolContainer>
              </Grid>
              {/* Weather Info */}
              <Grid xs={12} className="tool-item tool-item-weather">
                <ToolContainer sx={toolContainerSx} toolId="weather_info">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <WeatherIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel
                      name={getToolDisplayName('weather_info')}
                      description={getToolDescription('weather_info')}
                    />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('weather_info')}
                    checked={tools.includes('weather_info')}
                  />
                </ToolContainer>
              </Grid>
              {/* On This Day (Wikipedia) */}
              <Grid xs={12} className="tool-item tool-item-wikipedia-on-this-day">
                <ToolContainer sx={toolContainerSx} toolId="wikipedia_on_this_day">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <HistoryIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel
                      name={getToolDisplayName('wikipedia_on_this_day')}
                      description={getToolDescription('wikipedia_on_this_day')}
                    />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('wikipedia_on_this_day')}
                    checked={tools.includes('wikipedia_on_this_day')}
                  />
                </ToolContainer>
              </Grid>
              {/* ISS Tracker */}
              <Grid xs={12} className="tool-item tool-item-iss-tracker">
                <ToolContainer sx={toolContainerSx} toolId="iss_tracker">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <SatelliteIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel
                      name={getToolDisplayName('iss_tracker')}
                      description={getToolDescription('iss_tracker')}
                    />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('iss_tracker')}
                    checked={tools.includes('iss_tracker')}
                  />
                </ToolContainer>
              </Grid>
              {/* Sunrise/Sunset */}
              <Grid xs={12} className="tool-item tool-item-sunrise-sunset">
                <ToolContainer sx={toolContainerSx} toolId="sunrise_sunset">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <SunriseIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel
                      name={getToolDisplayName('sunrise_sunset')}
                      description={getToolDescription('sunrise_sunset')}
                    />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('sunrise_sunset')}
                    checked={tools.includes('sunrise_sunset')}
                  />
                </ToolContainer>
              </Grid>
              {/* Moon Phase */}
              <Grid xs={12} className="tool-item tool-item-moon-phase">
                <ToolContainer sx={toolContainerSx} toolId="moon_phase">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <MoonIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel name={getToolDisplayName('moon_phase')} description={getToolDescription('moon_phase')} />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('moon_phase')}
                    checked={tools.includes('moon_phase')}
                  />
                </ToolContainer>
              </Grid>
              {/* Planet Visibility */}
              <Grid xs={12} className="tool-item tool-item-planet-visibility">
                <ToolContainer sx={toolContainerSx} toolId="planet_visibility">
                  <Box
                    className="tool-content"
                    sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}
                  >
                    <PlanetIcon
                      sx={{ color: theme => `${theme.palette.text.primary}80`, fontSize: '1.25rem', flexShrink: 0 }}
                    />
                    <ToolLabel
                      name={getToolDisplayName('planet_visibility')}
                      description={getToolDescription('planet_visibility')}
                    />
                  </Box>
                  <SquareSlideToggle
                    onChange={() => handleToggleTool('planet_visibility')}
                    checked={tools.includes('planet_visibility')}
                  />
                </ToolContainer>
              </Grid>
            </Box>
          </ToolGateContext.Provider>
        </>
      )}

      {/* Deep Research Config Modal */}
      <DeepResearchConfigModal open={deepResearchConfigOpen} onClose={() => setDeepResearchConfigOpen(false)} />

      {/* Image Generation Model Selection Modal */}
      <ImageGenerationModelSelectionModal
        open={imageGenModelSelectionOpen}
        onClose={() => setImageGenModelSelectionOpen(false)}
      />
    </>
  );
};

export default ToolsSection;
