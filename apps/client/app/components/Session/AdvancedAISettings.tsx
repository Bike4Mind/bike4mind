import { FC, useEffect, useRef } from 'react';

import { Box } from '@mui/joy';

import { ImageModels, ISessionDocument, isGPTImageModel } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useGetSessionAgents } from '@client/app/hooks/data/agents';
import { useIsMobile, useIsTablet } from '@client/app/hooks/useIsMobile';
import { useShallow } from 'zustand/react/shallow';
import { useModelInfo } from '../../hooks/data/useModelInfo';
import InspectableSettingsButton from './AISettings/InspectableSettingsButton';
import { AdvancedAIModal } from './AISettings/AdvancedAIModal';
import { isImageModel } from '@client/app/utils/commands';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import ToolsButton from './AISettings/ToolsButton';
import AgentsButton from './AISettings/AgentsButton';
import StaleModelPrompt from './AISettings/StaleModelPrompt';
import { PromptBuilderModal } from './PromptBuilder/PromptBuilderModal';

// Re-export store for consumers that import from this file
export { useAdvancedAISettings } from './AISettings/useAdvancedAISettingsStore';
import { useAdvancedAISettings } from './AISettings/useAdvancedAISettingsStore';
import { useOverflowCompact } from './AISettings/useOverflowCompact';
import { useActiveTools } from './AISettings/useActiveTools';

interface AISettingsProps {
  stream: boolean;
  setStream: (stream: boolean) => void;
  spokenWords: number;
  setSpokenWords: (spokenWords: number) => void;
  voiceOver?: boolean;
  onRollDice: () => void;
  currentSession: ISessionDocument | null;
  /** Told whenever the row collapses to icon buttons or expands again (SessionToolbar). */
  onCompactChange?: (compact: boolean) => void;
}

const AISettings: FC<AISettingsProps> = ({
  stream,
  setStream,
  spokenWords,
  setSpokenWords,
  voiceOver,
  onRollDice,
  currentSession,
  onCompactChange,
}) => {
  const [showAdvancedSettings, setShowAdvancedSettings] = useAdvancedAISettings(
    useShallow(state => [state.showAdvancedSettings, state.setShowAdvancedSettings])
  );

  const { isFeatureEnabled, isAdminFeatureEnabled } = useFeatureEnabled();
  const isAgentsFeatureEnabled = isFeatureEnabled('enableAgents');
  const isPromptBuilderEnabled = isAdminFeatureEnabled('EnablePromptBuilder');

  const {
    tools,
    toolMode,
    disabledTools,
    activePrimaryTools,
    isThinkingActive,
    activeMcpServers,
    availableMcpServers,
    otherActiveToolsCount,
  } = useActiveTools(currentSession);
  const { setState: setLLM } = useLLM;

  const { currentSessionId, workBenchAgents } = useSessions();
  const { data: sessionAgents = [] } = useGetSessionAgents(currentSessionId);
  const activeAgentsCount = currentSessionId ? sessionAgents.length : workBenchAgents.length;

  const [model, quality] = useLLM(useShallow(s => [s.model, s.quality]));

  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  // Split views, docked and floating chats and small windows leave the row too little room for the
  // model name and Tools and Agents with labels and indicators; all three shrink to square icon
  // buttons until it fits, the model name moving to the gear's tooltip.
  const rowRef = useRef<HTMLDivElement>(null);
  const composerCompact = useOverflowCompact(rowRef);
  useEffect(() => {
    onCompactChange?.(composerCompact);
  }, [composerCompact, onCompactChange]);
  const { data: modelInfoRepo } = useModelInfo();
  const modelInfo = modelInfoRepo?.find(m => m.id === model);

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
        ref={rowRef}
        display="flex"
        justifyContent="flex-start"
        alignItems="center"
        gap={isMobile ? '12px' : '10px'}
        sx={{
          flexGrow: 1,
          // Phones: take exactly the free width, so a long model name ellipsizes inside it rather
          // than squeezing the plus button beside it.
          ...(isMobile && { flexBasis: 0, minWidth: 0 }),
          overflowX: 'auto',
          overflowY: 'visible',
        }}
      >
        {/* AI Model Picker */}
        <InspectableSettingsButton
          onClick={() => setShowAdvancedSettings(true)}
          modelName={modelInfo?.name}
          // Phones keep the name: Tools and Agents live in the plus menu there, so the model has
          // the row to itself.
          hideModelName={composerCompact && !isMobile}
          fluid={isMobile}
        />

        {/* Tools and Agents: on phones these render only their panels, opened from the plus menu. */}
        <ToolsButton
          isMobile={isMobile}
          isTablet={isTablet}
          iconOnly={composerCompact}
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

        {isAgentsFeatureEnabled && (
          <AgentsButton
            isMobile={isMobile}
            isTablet={isTablet}
            activeAgentsCount={activeAgentsCount}
            iconOnly={composerCompact}
          />
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
