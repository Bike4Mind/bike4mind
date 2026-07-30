import { ChangeEvent, FC, useCallback, useEffect, useState } from 'react';

import { Badge, Box, IconButton, Input, Tooltip } from '@mui/joy';

import { ImageModels, ISessionDocument, isGPTImageModel } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useGetSessionAgents } from '@client/app/hooks/data/agents';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useConfig } from '@client/app/hooks/data/settings';
import { filterToolsForDisplay } from '@client/app/utils/toolMapping';
import { useIsMobile, useIsTablet } from '@client/app/hooks/useIsMobile';
import { Casino as CasinoIcon, Tag as TagIcon } from '@mui/icons-material';
import { useShallow } from 'zustand/react/shallow';
import { useModelInfo } from '../../hooks/data/useModelInfo';
import InspectableSettingsButton from './AISettings/InspectableSettingsButton';
import { AdvancedAIModal } from './AISettings/AdvancedAIModal';
import { useHydrateModelFromSession } from './AISettings/useHydrateModelFromSession';
import { isImageModel } from '@client/app/utils/commands';
import { keyframes } from '@mui/system';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import ToolsButton from './AISettings/ToolsButton';
import { ICONED_MCP_SERVERS } from '../common/ToolIndicators';
import AgentsButton from './AISettings/AgentsButton';
import StaleModelPrompt from './AISettings/StaleModelPrompt';
import BriefcaseButton from './AISettings/BriefcaseButton';
import ResearchModeIndicator from './AISettings/ResearchModeIndicator';
import { ImageTemplateControls } from './ImageTemplates/ImageTemplateControls';
import { PromptBuilderModal } from './PromptBuilder/PromptBuilderModal';
import { isImageGenerationModel } from './PromptBuilder/models';
import { usePromptBuilderFirstRun } from './PromptBuilder/usePromptBuilderFirstRun';
import { AutoAwesome as PromptBuilderIcon } from '@mui/icons-material';

// Re-export store for consumers that import from this file
export { useAdvancedAISettings } from './AISettings/useAdvancedAISettingsStore';
import { useAdvancedAISettings } from './AISettings/useAdvancedAISettingsStore';

const rollAnimation = keyframes`
0% { transform: rotate(0deg); }
100% { transform: rotate(360deg); }
`;

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
  const [showAdvancedSettings, setShowAdvancedSettings, setPromptBuilderOpen] = useAdvancedAISettings(
    useShallow(state => [state.showAdvancedSettings, state.setShowAdvancedSettings, state.setPromptBuilderOpen])
  );

  const { isFeatureEnabled, isAdminFeatureEnabled } = useFeatureEnabled();
  const isAgentsFeatureEnabled = isFeatureEnabled('enableAgents');
  const isQuestMasterFeatureEnabled = isFeatureEnabled('enableQuestMaster');
  const isLatticeFeatureEnabled = isFeatureEnabled('enableLattice');
  const isBriefcaseEnabled = isFeatureEnabled('enableBriefcase');
  const isImageTemplatesEnabled = isAdminFeatureEnabled('EnableImageTemplates');
  const isPromptBuilderEnabled = isAdminFeatureEnabled('EnablePromptBuilder');
  const { showHint: showPromptBuilderHint, markSeen: markPromptBuilderSeen } = usePromptBuilderFirstRun();

  const tools = useLLM(state => state.tools);
  const toolMode = useLLM(state => state.toolMode);
  const enabledMcpServers = useLLM(state => state.enabledMcpServers);
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

  const [model, isQuestMasterEnabled, thinking, quality, n] = useLLM(
    useShallow(s => [s.model, s.isQuestMasterEnabled, s.thinking, s.quality, s.n])
  );

  const handleResponseCountChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(e.target.value, 10);
    if (!isNaN(newValue) && newValue >= 1 && newValue <= 4) {
      setLLM({ n: newValue });
    }
  };

  const primaryTools = ['web_search', 'web_fetch', 'image_generation'] as const;
  // Indicators must agree with the Tools picker: a tool whose key is missing renders
  // off there, so it must not show an icon or feed the "+N" badge here either. The
  // raw `tools` still goes to ToolsButton below - that array is what handleToggleTool
  // reads and rewrites, so filtering it would drop preferences on the next toggle.
  const displayTools = filterToolsForDisplay(tools, serverConfig?.toolAvailability);
  const activePrimaryTools = primaryTools.filter(tool => displayTools.includes(tool));
  const isThinkingActive = thinking?.enabled ?? false;
  // Enabled integrations without their own icon (e.g. linkedin, notion) roll into the
  // "+N" badge; iconed ones (ICONED_MCP_SERVERS) are shown as icons and excluded here
  // so they aren't double-counted. Mirrors ToolIndicators' shouldShowMcpServer logic.
  const enabledNonIconMcpCount = availableMcpServers.filter(
    name => !ICONED_MCP_SERVERS.includes(name) && (enabledMcpServers === null || enabledMcpServers.includes(name))
  ).length;
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

  const [isRolling, setIsRolling] = useState(false);

  const handleClickDice = () => {
    setIsRolling(true);
    setTimeout(() => setIsRolling(false), 4000);
    onRollDice();
  };

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
          py: isMobile ? '0px' : '10px',
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
          enabledMcpServers={enabledMcpServers}
          availableMcpServers={availableMcpServers}
          setTools={newTools => setLLM({ tools: newTools })}
        />

        {/* Agents */}
        {isAgentsFeatureEnabled && (
          <AgentsButton isMobile={isMobile} isTablet={isTablet} activeAgentsCount={activeAgentsCount} />
        )}

        {/* Briefcase - one-click prompt catalog */}
        {isBriefcaseEnabled && <BriefcaseButton isMobile={isMobile} isTablet={isTablet} />}

        {/* Number of Responses (Image Models only) */}
        {!isTablet && isImageModel(model) && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: '32px',
              borderRadius: '6px',
            }}
          >
            <TagIcon sx={{ color: 'text.primary', fontSize: '18px', mr: '4px' }} />
            <Tooltip title="Number of Responses">
              <Input
                data-testid="image-response-count-input"
                sx={{
                  width: '3vw',
                  minWidth: '48px',
                  height: '32px',
                  backgroundColor: 'background.surface',
                  color: 'text.primary',
                }}
                size="sm"
                id="nEdit"
                variant="outlined"
                type="number"
                value={n ?? 1}
                onChange={handleResponseCountChange}
                slotProps={{ input: { sx: { textAlign: 'center' }, min: 1, max: 4 } }}
              />
            </Tooltip>
          </Box>
        )}

        {/* Image Templates (save/apply reusable image-mode settings) */}
        {isImageTemplatesEnabled && isImageModel(model) && <ImageTemplateControls />}

        {/* Prompt Builder (guided prompt construction; generation models only) */}
        {isPromptBuilderEnabled && isImageGenerationModel(model) && (
          <Tooltip title={showPromptBuilderHint ? 'New: build image prompts here' : 'Prompt Builder'}>
            <Badge
              size="sm"
              color="primary"
              variant="solid"
              badgeInset="4px"
              invisible={!showPromptBuilderHint}
              data-testid="prompt-builder-hint-badge"
            >
              <IconButton
                data-testid="prompt-builder-open-btn"
                variant="outlined"
                color="neutral"
                size="sm"
                sx={{ height: '32px', width: '32px', borderRadius: '6px' }}
                onClick={() => {
                  markPromptBuilderSeen();
                  setPromptBuilderOpen(true);
                }}
              >
                <PromptBuilderIcon sx={{ fontSize: '16px' }} />
              </IconButton>
            </Badge>
          </Tooltip>
        )}

        {!isTablet && (
          <>
            {/* Dice Roll Icon. Raw `tools` on purpose: dice_roll needs no API key, so
                it has no toolAvailability entry and can never be key-gated. */}
            {tools.includes('dice_roll') && (
              <Tooltip title="Roll Dice">
                <IconButton
                  variant={'outlined'}
                  color={'neutral'}
                  size="sm"
                  sx={{ height: '32px', width: '32px', borderRadius: '6px' }}
                  disabled={isRolling}
                  onClick={handleClickDice}
                >
                  <Box
                    sx={{
                      animation: isRolling ? `${rollAnimation} 0.5s linear infinite` : 'none',
                      display: 'flex',
                    }}
                  >
                    <CasinoIcon sx={{ fontSize: '16px' }} />
                  </Box>
                </IconButton>
              </Tooltip>
            )}

            {/* Research Mode Indicator */}
            <ResearchModeIndicator />
          </>
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
      />

      {isPromptBuilderEnabled && <PromptBuilderModal />}

      {/* Offers an upgrade when the session resumed on a superseded pin (#951) */}
      <StaleModelPrompt sessionId={currentSessionId} pinnedModel={currentSession?.lastUsedModel} />
    </>
  );
};

export default AISettings;
