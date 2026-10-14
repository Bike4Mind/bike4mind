import { FC, useCallback, useEffect } from 'react';

import { Box } from '@mui/joy';

import { ImageModels, ISessionDocument, isGPTImageModel } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useGetSessionAgents } from '@client/app/hooks/data/agents';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useConfig } from '@client/app/hooks/data/settings';
import { filterToolsForDisplay } from '@client/app/utils/toolMapping';
import { useIsMobile, useIsTablet } from '@client/app/hooks/useIsMobile';
import { useShallow } from 'zustand/react/shallow';
import { useModelInfo } from '../../hooks/data/useModelInfo';
import InspectableSettingsButton from './AISettings/InspectableSettingsButton';
import { AdvancedAIModal } from './AISettings/AdvancedAIModal';
import { useHydrateModelFromSession } from './AISettings/useHydrateModelFromSession';
import { isImageModel } from '@client/app/utils/commands';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import ToolsButton from './AISettings/ToolsButton';
import { ICONED_MCP_SERVERS, AGENT_ONLY_MCP_SERVERS } from '../common/ToolIndicators';
import AgentsButton from './AISettings/AgentsButton';
import StaleModelPrompt from './AISettings/StaleModelPrompt';
import { PromptBuilderModal } from './PromptBuilder/PromptBuilderModal';

// Re-export store for consumers that import from this file
export { useAdvancedAISettings } from './AISettings/useAdvancedAISettingsStore';
import { useAdvancedAISettings } from './AISettings/useAdvancedAISettingsStore';

interface AISettingsProps {
  stream: boolean;
  setStream: (stream: boolean) => void;
  spokenWords: number;
  setSpokenWords: (spokenWords: number) => void;
  voiceOver?: boolean;
  onRollDice: () => void;
  currentSession: ISessionDocument | null;
}

const AISettings: FC<AISettingsProps> = ({
  stream,
  setStream,
  spokenWords,
  setSpokenWords,
  voiceOver,
  onRollDice,
  currentSession,
}) => {
  const [showAdvancedSettings, setShowAdvancedSettings] = useAdvancedAISettings(
    useShallow(state => [state.showAdvancedSettings, state.setShowAdvancedSettings])
  );

  const { isFeatureEnabled, isAdminFeatureEnabled } = useFeatureEnabled();
  const isAgentsFeatureEnabled = isFeatureEnabled('enableAgents');
  const isQuestMasterFeatureEnabled = isFeatureEnabled('enableQuestMaster');
  const isLatticeFeatureEnabled = isFeatureEnabled('enableLattice');
  const isPromptBuilderEnabled = isAdminFeatureEnabled('EnablePromptBuilder');

  const tools = useLLM(state => state.tools);
  const toolMode = useLLM(state => state.toolMode);
  const enabledMcpServers = useLLM(state => state.enabledMcpServers);
  const skipAutoOffers = useLLM(state => state.skipAutoOffers);
  const { setState: setLLM } = useLLM;

  // Presence-only availability of key-gated tools. Already mounted app-wide by
  // WebsocketConfigProvider with a 5-min staleTime, so this shares that cache
  // rather than adding a request.
  const { data: serverConfig } = useConfig();
  const { data: mcpServersData = [] } = useMcpServers();
  const availableMcpServers = mcpServersData.filter(server => server.enabled).map(server => server.name);

  const { currentSessionId, workBenchAgents } = useSessions();
  const { data: sessionAgents = [] } = useGetSessionAgents(currentSessionId);
  const activeAgentsCount = currentSessionId ? sessionAgents.length : workBenchAgents.length;

  const isLatticeEnabled = useLLM(state => state.isLatticeEnabled);
  const isAgentsEnabled = useLLM(state => state.isAgentsEnabled);

  const [model, isQuestMasterEnabled, thinking, quality] = useLLM(
    useShallow(s => [s.model, s.isQuestMasterEnabled, s.thinking, s.quality])
  );

  const primaryTools = ['web_search', 'web_fetch', 'image_generation'] as const;
  // Indicators must agree with the Tools picker: a tool whose key is missing renders
  // off there, and one the session denies is not listed at all, so neither may show an
  // icon or feed the "+N" badge here. The raw `tools` still goes to ToolsButton below -
  // that array is what handleToggleTool reads and rewrites, so filtering it would drop
  // preferences on the next toggle.
  const disabledTools = currentSession?.disabledTools;
  const displayTools = filterToolsForDisplay(tools, serverConfig?.toolAvailability, disabledTools);
  const activePrimaryTools = primaryTools.filter(tool => displayTools.includes(tool));
  const isThinkingActive = thinking?.enabled ?? false;
  // Integrations that actually reach this turn. "Only tools I pick" withholds every
  // non-agent-only MCP tool server-side (`offerOnlyNamedTools` in sharedToolBuilder), so
  // those integrations contribute nothing and must not read as active here - the same
  // reason ToolsButton hides every indicator in Fast mode. Agent-only servers are exempt
  // from that gate (delegation reaches them either way), so they keep their icon.
  const activeMcpServers = availableMcpServers.filter(
    name =>
      (enabledMcpServers === null || enabledMcpServers.includes(name)) &&
      (!skipAutoOffers || AGENT_ONLY_MCP_SERVERS.includes(name))
  );
  // Active integrations without their own icon (e.g. linkedin, notion) roll into the
  // "+N" badge; iconed ones (ICONED_MCP_SERVERS) are shown as icons and excluded here
  // so they aren't double-counted.
  const enabledNonIconMcpCount = activeMcpServers.filter(name => !ICONED_MCP_SERVERS.includes(name)).length;
  // Feature-gated switches outside the `tools` array (Quest Master, Agent Detection,
  // Lattice). Must stay in sync with pinnedCount's specialToolsCount in ToolsSection.
  const specialToolsCount =
    (isQuestMasterFeatureEnabled && isQuestMasterEnabled ? 1 : 0) +
    (isAgentsFeatureEnabled && isAgentsEnabled ? 1 : 0) +
    (isLatticeFeatureEnabled && isLatticeEnabled ? 1 : 0);
  const otherActiveToolsCount =
    displayTools.filter(
      tool => !primaryTools.includes(tool as unknown as (typeof primaryTools)[number]) && tool !== 'dice_roll'
    ).length +
    specialToolsCount +
    enabledNonIconMcpCount;

  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const { data: modelInfoRepo } = useModelInfo();
  const modelInfo = modelInfoRepo?.find(m => m.id === model);

  // Adopt the session's pinned model once per session. Must NOT re-run on every
  // `currentSession` identity change -- see useHydrateModelFromSession for why that
  // silently reverted the user's model selection on send.
  const applyModelFromSession = useCallback((nextModel: string) => setLLM({ model: nextModel }), [setLLM]);
  useHydrateModelFromSession(currentSession, applyModelFromSession);

  // Reset QuestMaster to disabled when model changes
  useEffect(() => {
    setLLM({ isQuestMasterEnabled: false });
  }, [model, setLLM]);

  // Reset quality to default when switching between image models
  useEffect(() => {
    if (isImageModel(model)) {
      const defaultQuality = isGPTImageModel(model) ? 'low' : 'standard';
      if (quality !== defaultQuality) {
        setLLM({ quality: defaultQuality });
      }
      if (model === ImageModels.GROK_IMAGINE_IMAGE_QUALITY) {
        setLLM({ style: 'natural' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  return (
    <>
      <Box
        display="flex"
        justifyContent="flex-start"
        alignItems="center"
        gap={isMobile ? '12px' : '10px'}
        sx={{
          flexGrow: 1,
          overflowX: 'auto',
          overflowY: 'visible',
        }}
      >
        {/* AI Model Picker */}
        <InspectableSettingsButton onClick={() => setShowAdvancedSettings(true)} modelName={modelInfo?.name} />

        {/* Tools */}
        <ToolsButton
          isMobile={isMobile}
          isTablet={isTablet}
          tools={tools}
          toolMode={toolMode}
          model={model}
          onRollDice={onRollDice}
          activePrimaryTools={activePrimaryTools}
          isThinkingActive={isThinkingActive}
          otherActiveToolsCount={otherActiveToolsCount}
          enabledMcpServers={activeMcpServers}
          availableMcpServers={availableMcpServers}
          setTools={newTools => setLLM({ tools: newTools })}
          disabledTools={disabledTools}
        />

        {/* Agents */}
        {isAgentsFeatureEnabled && (
          <AgentsButton isMobile={isMobile} isTablet={isTablet} activeAgentsCount={activeAgentsCount} />
        )}
      </Box>

      {/* Modal for advanced settings */}
      <AdvancedAIModal
        open={showAdvancedSettings}
        onClose={() => setShowAdvancedSettings(false)}
        spokenWords={spokenWords}
        setSpokenWords={setSpokenWords}
        stream={stream}
        setStream={setStream}
        voiceOver={voiceOver || false}
        onRollDice={onRollDice}
        disabledTools={disabledTools}
      />

      {isPromptBuilderEnabled && <PromptBuilderModal />}

      {/* Offers an upgrade when the session resumed on a superseded pin (#951) */}
      <StaleModelPrompt sessionId={currentSessionId} pinnedModel={currentSession?.lastUsedModel} />
    </>
  );
};

export default AISettings;
