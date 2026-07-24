import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useShallow } from 'zustand/react/shallow';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useLocation, useSearch } from '@tanstack/react-router';
import { createOptimisticPromptBubble, createOptimisticSessionId } from '@client/app/utils/llm';
import { useSessionRouter } from '@client/app/hooks/useSessionRouter';

import {
  B4MLLMTools,
  GenerateImageToolCall,
  IChatHistoryItemDocument,
  ISessionDocument,
  ModelName,
  requiresImageInput,
} from '@bike4mind/common';
import type { IAgent } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useSessions, useWorkBenchFiles } from '@client/app/contexts/SessionsContext';
import { handleLLMCommand } from '@client/app/components/commands/LLMCommand';
import { commandHandlers } from './sessionBottomConstants';
import { pickRoutingSource } from './pickRoutingSource';
import { resolveDispatchTools } from './resolveDispatchTools';
import { useSessionCacheMigration } from '../hooks/useSessionCacheMigration';
import { useLLMSettingsAssembly } from '../hooks/useLLMSettingsAssembly';
import { useRecordImageTemplateUse, isTemplateUseEligiblePrompt } from '../ImageTemplates/useRecordImageTemplateUse';
import { useProgrammaticSubmit } from '../hooks/useProgrammaticSubmit';
import { useGetAgents, useGetSessionAgents } from '@client/app/hooks/data/agents';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useChatInput, NEW_NOTEBOOK_DRAFT_KEY } from '@client/app/hooks/useChatInput';
import useSessionLayout, {
  setSessionLayout,
  setPendingMessageFiles,
  getSendableMessageFileIds,
} from '@client/app/hooks/useSessionLayout';
import type { useSubscribeChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import {
  detectAgentMentions,
  findAgentsByMentions,
  useAttachAgentsToSession,
} from '@client/app/hooks/useAgentMentions';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';
import { useAgentExecutionStore } from '@client/app/stores/useAgentExecutionStore';
import { classifyQueryComplexity, routeQuery } from '@bike4mind/common';
import { pickOrchestrationAgent } from '@client/app/utils/agentOrchestration';
import { evaluateShortCircuits, hasExplicitAgentLiteral } from '@client/app/utils/intentClassifierShortCircuits';
import { useIntentClassifier } from '@client/app/hooks/useIntentClassifier';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useTokenLimits } from '@client/app/hooks/useTokenLimits';
import { CommandKey, extractCommandAndParams, handleCommand, isImageModel } from '@client/app/utils/commands';
import { validateChatInput } from '@client/app/utils/validateChatInput';
import { recordSessionActivity } from '@client/app/utils/sessionActivityCleanup';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { generateNewSession, stopChatMessage } from '@client/app/utils/sessionsAPICalls';
import { INFINITE_VALUE } from '@client/app/components/FibonacciSlider';
import { useAdvancedAISettings } from '@client/app/components/Session/AdvancedAISettings';
import { useModelInfo } from '../../../hooks/data/useModelInfo';
import { useAccessibleModels } from '../../../hooks/useAccessibleModels';
import perfLogger from '../../../utils/performanceLogger';
import { consumeQuestLaunchIntent } from '../../../utils/questLaunchIntent';
import { LexicalChatInputRef } from '../LexicalChatInput';

// Sentinel statusMessage written by `handleSendClick` to render the Stop
// affordance the instant the user clicks Send, masking backend cold-start
// latency before the WS handler has emitted a real stream event. The real
// stream overwrites this on first event; the error path detects it via strict
// equality and clears so the Send button reappears.
//
// Load-bearing: the character is U+2026 (HORIZONTAL ELLIPSIS), not three ASCII
// dots. Server-emitted status messages (`'Cancelling generation...'`,
// `'Running...'`, etc.) use ASCII `...`, so the strict-equality rollback below
// can't accidentally clobber a real WS event.
const OPTIMISTIC_GENERATING_STATUS = 'Generating…';

interface UseSendMessageParams {
  lexicalInputRef: React.RefObject<LexicalChatInputRef | null>;
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>;
  clearFiles: () => void;
  stream: boolean;
  setChatCompletion: ReturnType<typeof useSubscribeChatCompletion>['setChatCompletion'];
  onAgentsAttached?: () => void;
}

interface UseSendMessageResult {
  submitting: boolean;
  stoppingMessage: boolean;
  pendingAutoSubmitGoal: string | null;
  handleSendClick: (
    prompt?: string,
    options?: { forceEnableQuestMaster?: boolean; toolsOverride?: B4MLLMTools[] }
  ) => Promise<IChatHistoryItemDocument | undefined>;
  handleStopMessage: () => Promise<void>;
}

/**
 * Encapsulates all message-sending logic for the SessionBottom:
 * - handleSendClick: validates input, dispatches to command or LLM handler,
 *   performs optimistic navigation for new sessions, and resets UI state.
 * - handleStopMessage: cancels an in-flight generation.
 * - Auto-submit effect: fires a queued quest goal once the websocket is open.
 *
 * Two concerns are delegated to dedicated hooks:
 * - useLLMSettingsAssembly: builds the LLMSettings payload and resolves the
 *   effective tool list (Smart/Fast/briefcase-override ladder).
 * - useProgrammaticSubmit: drives external sends via useChatInput.programmaticSubmit
 *   and briefcase programmaticLaunch dispatches.
 */
export function useSendMessage({
  lexicalInputRef,
  chatInputRef,
  clearFiles,
  stream,
  setChatCompletion,
  onAgentsAttached,
}: UseSendMessageParams): UseSendMessageResult {
  const {
    currentSession,
    currentSessionId,
    addMessageToSession,
    setCurrentSession,
    workBenchAgents,
    setWorkBenchAgents,
    setCurrentSessionId,
  } = useSessions();

  const pendingFirstMessage = useSessionLayout(s => s.pendingFirstMessage);
  const effectiveSessionId = pendingFirstMessage ? null : currentSessionId;

  const workBenchFiles = useWorkBenchFiles(currentSessionId || undefined);
  const { currentUser } = useUser();
  // Send-time validation must see the live balance - the server enforces
  // credits on the reservation regardless, but the frozen display value
  // would let this client-side check miss a genuine mid-turn exhaustion.
  const effectiveCredits = useEffectiveCredits({ live: true });
  const { sendJsonMessage, readyState, resetLastJsonMessage } = useWebsocket();
  const queryClient = useQueryClient();
  const { migrateQuests, migrateSession, cleanupOptimistic } = useSessionCacheMigration();
  const { assembleSettings, resolveTools } = useLLMSettingsAssembly();
  const recordImageTemplateUse = useRecordImageTemplateUse();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId: routerProjectId } = useSearch({ strict: false }) as { projectId?: string };
  const { data: modelInfo } = useModelInfo();
  const { accessibleModels, userTags } = useAccessibleModels();
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  // Layer-1 admin gate via `useFeatureEnabled('agentMode')`. Mirrors the check in
  // `SessionToolbar`, and must go through the same gate so the EnableAgentMode
  // org-wide kill switch and EnableAgentModeDefault admin default actually reach
  // routing - not just the raw per-user pref. Otherwise a user who flipped the
  // bolt ON and later lost the feature (admin kill switch) would silently keep
  // routing every send to `agent_executor` with no UI to disable it.
  const { settings: userSettings } = useUserSettings();
  const { isFeatureEnabled } = useFeatureEnabled();
  const agentModeFeatureEnabled = isFeatureEnabled('agentMode');
  // Layer-2 preference. Default `'off'` per IUserPreferences. Only meaningful
  // when Layer-1 (`agentModeFeatureEnabled`, resolved above via
  // `useFeatureEnabled('agentMode')`) is true; non-gated users never reach the
  // classifier branch below. Read from `userSettings` (not
  // `currentUser.preferences`) so optimistic writes via `updatePreferences`
  // take effect on the very next send instead of waiting for the server echo.
  const agentModeDefault = userSettings.agentModeDefault ?? 'off';
  const { getSettingObject } = useAdminSettings();
  // Admin-level kill switch. Default to enabled so the classifier runs unless
  // an admin explicitly turns it off; matches `IntentClassifierConfigSchema`.
  const intentClassifierAdminEnabled =
    getSettingObject<{ intentClassifier?: { enabled?: boolean } }>('orchestrationDefaults', {})?.intentClassifier
      ?.enabled !== false;
  const classifyIntent = useIntentClassifier();
  const liveAI = useAdvancedAISettings(state => state.liveAI);
  const { data: availableAgents = [] } = useGetAgents();
  const { data: sessionAgents = [] } = useGetSessionAgents(effectiveSessionId);

  const [
    model,
    imageModel,
    imageEditModel,
    temperature,
    max_tokens,
    size,
    quality,
    style,
    isQuestMasterEnabled,
    isMementosEnabled,
    isArtifactsEnabled,
    isAgentsEnabled,
    isLatticeEnabled,
    tools,
    safety_tolerance,
    prompt_upsampling,
    seed,
    output_format,
    researchMode,
    thinking,
    enabledMcpServers,
    deepResearchConfig,
    organizationId,
    agentMode,
    disableAutoRouteForThisSession,
  ] = useLLM(
    useShallow(s => [
      s.model,
      s.imageModel,
      s.imageEditModel,
      s.temperature,
      s.max_tokens,
      s.size,
      s.quality,
      s.style,
      s.isQuestMasterEnabled,
      s.isMementosEnabled,
      s.isArtifactsEnabled,
      s.isAgentsEnabled,
      s.isLatticeEnabled,
      s.tools,
      s.safety_tolerance,
      s.prompt_upsampling,
      s.seed,
      s.output_format,
      s.researchMode,
      s.thinking,
      s.enabledMcpServers,
      s.deepResearchConfig,
      s.organizationId,
      s.agentMode,
      s.disableAutoRouteForThisSession,
    ])
  );
  const { setState: setLLM } = useLLM;

  const [chatInputValue, setChatInputValue, clearDraft] = useChatInput(
    useShallow(s => [s.chatInputValue, s.setChatInputValue, s.clearDraft])
  );

  const pendingMessageFilesRaw = useSessionLayout(s => s.pendingMessageFiles);
  const pendingMessageFiles = pendingMessageFilesRaw ?? [];

  const { safeMaxTokens, maxInputTokens, effectiveMaxOutputTokens } = useTokenLimits({
    model,
    modelInfo,
    max_tokens,
    chatInputLength: chatInputValue.length,
  });

  const attachAgentsToSession = useAttachAgentsToSession({
    currentSessionId,
    sessionAgents,
    onAgentsAttached,
  });

  // Imperative dispatch API for `@mention` routing below. The matching WS
  // subscriptions live at app root (`AgentExecutionSubscriber`) so they
  // survive route navigation - keeping them here used to drop the first
  // `execution_started` event during the `/new -> /notebooks/$id` swap.
  const agentExecution = useAgentExecutionDispatch();

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [stoppingMessage, setStoppingMessage] = useState<boolean>(false);
  const [pendingAutoSubmitGoal, setPendingAutoSubmitGoal] = useState<string | null>(null);
  const [enableQuestMasterOnSubmit, setEnableQuestMasterOnSubmit] = useState(false);

  // Consume a quest launch intent from the /quests page (auto-submit).
  // The /new route records it in a useLayoutEffect, which runs before this
  // effect; consume-once semantics prevent replay on refresh or remount.
  useEffect(() => {
    const intent = consumeQuestLaunchIntent();
    if (intent) {
      setChatInputValue(intent.goal);

      if (intent.autoSubmit) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPendingAutoSubmitGoal(intent.goal);
        if (intent.enableQuestMaster) {
          setEnableQuestMasterOnSubmit(true);
        }
      }
    }
  }, [setChatInputValue]);

  const handleStopMessage = async (): Promise<void> => {
    if (!currentSessionId) return;

    setStoppingMessage(true);
    setChatCompletion(prev => ({
      ...prev,
      quest: { ...prev.quest, sessionId: currentSessionId },
      stopped: true,
      statusMessage: 'Cancelling generation...',
    }));

    try {
      await stopChatMessage(currentSessionId);
      toast.success('Generation cancelled successfully');
      setChatCompletion(prev => ({
        ...prev,
        completed: true,
        statusMessage: 'Generation cancelled by user',
      }));
    } catch (error) {
      console.error('Error stopping chat message:', error);
      toast.error('Error cancelling generation');
      setChatCompletion(prev => ({
        ...prev,
        stopped: false,
      }));
    } finally {
      setStoppingMessage(false);
    }
  };

  const handleSendClick = async (
    newPrompt?: string,
    options?: { forceEnableQuestMaster?: boolean; toolsOverride?: B4MLLMTools[] }
  ): Promise<IChatHistoryItemDocument | undefined> => {
    if (submitting) return;

    // For editor-driven sends (newPrompt === undefined) serialize the composer to
    // markdown so inline formatting (Ctrl+B / Ctrl+I) round-trips into the rendered
    // user bubble. getSerializedValue() emits plain text unchanged when no
    // formatting was applied, so slash-commands, the char counter, drafts, and
    // literal-markdown senders are unaffected. Falls back to the plain chatInputValue
    // when the editor ref isn't mounted. Programmatic sends pass newPrompt explicitly
    // and bypass the editor (mirrors the getMentions() guard below).
    const prompt = newPrompt ?? lexicalInputRef.current?.getSerializedValue() ?? chatInputValue;
    // Validation (and the message the server stores) sees the serialized prompt,
    // so a formatted message counts its markdown syntax toward the input budget
    // (e.g. `**bold**` is 4 chars over `bold`). The overhead is markup-only and
    // well within existing token headroom; flagged here in case token accounting
    // is ever tightened.
    const errorMessage = validateChatInput({
      inputText: prompt,
      accessibleModels,
      maxInputTokens,
      effectiveMaxOutputTokens,
      currentUser,
      effectiveCredits,
      enforceCredits,
    });
    if (errorMessage) {
      console.error(errorMessage);
      toast.error(errorMessage);
      return;
    }

    // Host-managed first-message creation (e.g. /opti's TREATED OptiHashi session).
    // When there is no active session and a host route has registered a session factory
    // (useSessionRouter.hostCreateSession), delegate creation to it instead of falling
    // through to the server's generic getOrCreateSession path - which would mint a
    // `surface: null` session and orphan the notebook from the surface's scoped nav.
    // The host creates the treated session, makes it active, and re-dispatches this exact
    // prompt via programmaticSubmit (consumed below once currentSession is non-null), so the
    // message is not lost - we return here to avoid a duplicate generic send.
    if (!currentSession) {
      const hostCreateSession = useSessionRouter.getState().hostCreateSession;
      if (hostCreateSession) {
        await hostCreateSession(prompt);
        return;
      }
    }

    setSubmitting(true);
    setSessionLayout({ selectedArtifactId: undefined, artifactData: undefined });
    const session = currentSession;
    let sessionToSend = session;
    let isNewSession = false;
    // Tracks the client-generated tmpId during optimistic pre-navigation so we
    // can clean up the fake cache entry if the API call fails.
    let optimisticTmpId: string | null = null;
    const enabledFiles = workBenchFiles.map(file => file.fileName);
    const [command, params] = extractCommandAndParams(liveAI, model, INFINITE_VALUE, prompt, enabledFiles);
    const userId = currentUser!.id;
    const projectId = routerProjectId;

    // Count a template use when a normal (non-slash-command) prompt is sent on an
    // image model whose settings match a saved template. Gate on the ORIGINAL
    // prompt, not `command` - the send path derives a `/gen_image` command for
    // image models, so `command` is always set here. Fire-and-forget; further
    // gated internally (feature flag, AI toggle, image model, settings match).
    if (isTemplateUseEligiblePrompt(prompt)) recordImageTemplateUse();

    // Detect agent mentions and auto-attach them before sending the message.
    //
    // Two sources, unioned:
    //   1. Structured mentions from the Lexical editor tree (`getMentions()`).
    //      This is the source of truth for anything the user picked from the
    //      typeahead - it survives hyphens, dots, and unicode, none of which
    //      a regex can safely round-trip. Only consulted when the prompt
    //      actually came from the editor (`newPrompt === undefined`); for
    //      programmatic sends (e.g. the opti "Draft a problem with AI") the editor
    //      tree is unrelated to the prompt being sent and would otherwise
    //      leak unrelated mentions left lingering in the input.
    //   2. Regex fallback over the raw prompt text. Covers callers that don't
    //      go through Lexical: programmatic sends, auto-submitted quest goals
    //      from localStorage, and any pasted `@handle` text the user didn't
    //      pick from the typeahead.
    let orchestrationAgent: IAgent | null = null;
    // First @mentioned agent (regardless of orchestration fields). Used as the
    // dispatch `agentId` when the run lands on the executor so the executor
    // injects THIS agent's persona - @tagging a plain persona agent must run it,
    // not the synthetic default (#agent-mode-persona / @-tag-enables-agent).
    let mentionedAgent: IAgent | null = null;
    try {
      const structuredMentions = newPrompt === undefined ? (lexicalInputRef.current?.getMentions() ?? []) : [];
      const textMentions = detectAgentMentions(prompt);
      const mentions = Array.from(new Set([...structuredMentions.map(m => m.value.toLowerCase()), ...textMentions]));

      if (mentions.length > 0) {
        perfLogger.log(`🔍 Detected agent mentions: ${mentions.join(', ')}`);
        const mentionedAgents = findAgentsByMentions(mentions, availableAgents);
        if (mentionedAgents.length > 0) {
          perfLogger.log(`🤖 Found matching agents: ${mentionedAgents.map(a => a.name).join(', ')}`);
          await attachAgentsToSession(mentionedAgents);
          mentionedAgent = mentionedAgents[0] ?? null;
          // Pick the orchestration-configured agent (if any) so routeQuery
          // can preserve the earlier `@specific-agent` dispatch path.
          orchestrationAgent = pickOrchestrationAgent(mentionedAgents);
        }
      }
    } catch (error) {
      console.error('Error auto-attaching agents:', error);
    }

    // Routing: `routeQuery()` is the single source of truth for whether to
    // dispatch the agent executor or the standard chat completion path.
    // It consolidates three signals into one decision:
    //   1. The Agent-mode toggle (`agentMode.enabled` -> `userOverride`)
    //   2. Mentioned orchestration agents (preserves the @specific-agent flow)
    //   3. The `@agent` literal trigger + complexity heuristic
    // The earlier branch that dispatched on `orchestrationAgent && isAgentsEnabled`
    // is intentionally removed - running both alongside would double-dispatch.
    const sessionFabFileIdsForRouting = workBenchFiles.map(f => f.id);
    // Exclude files still pending a content-moderation scan or already flagged 'blocked'
    // from every attachment-id set built below - otherwise a held/blocked image ships
    // with the message, the server silently skips it (buildDataSources ignores
    // unservable fabFiles), and neither the LLM nor the user gets any signal. The Send
    // button already stays disabled while scanning (hasBlockingPendingFiles in
    // useSessionLayout), so this is the last line of defense for that case (e.g. a
    // programmatic/auto-submit send that bypasses the button); for 'blocked' files, which
    // are meant to stay individually removable rather than trap the composer, this is the
    // only place they get excluded, so surface a toast once per send.
    const { ids: sendableMessageFileIds, hadBlocked: hasBlockedMessageFile } =
      getSendableMessageFileIds(pendingMessageFiles);
    if (hasBlockedMessageFile) {
      toast.warning("An image couldn't be added — it may violate our content policy.");
    }
    const messageFileIdsForRouting = sendableMessageFileIds;
    const complexity = classifyQueryComplexity(
      prompt,
      sessionFabFileIdsForRouting,
      messageFileIdsForRouting,
      tools,
      researchMode,
      sessionAgents.map(a => a.id)
    );
    // Real slash commands (e.g. `/gen_image`, `/roll`, `/gen_video`) must run
    // their own handler even when the Agent-mode toggle is ON - otherwise the
    // executor branch returns before `handler(sessionToSend)` is reached and
    // the command silently never executes. `/llm` is the implicit default and
    // does NOT count as a real slash command here.
    const isRealSlashCommand = command !== '/llm' && commandHandlers[command as CommandKey] !== undefined;
    // Gate the override on the Layer-1 flag so a stale persisted
    // `agentMode.enabled` doesn't outlive a feature-flag revocation, and skip
    // it entirely for real slash commands so they keep dispatching normally.
    const agentToggleActive = agentModeFeatureEnabled && agentMode.enabled && !isRealSlashCommand;
    // 'on' = "agent_executor used by default". Treated as a force_agent
    // override on every send (verification: Layer-1 + 'always on' + "hi" ->
    // ReAct dispatched). Layer-1 gated and slash-command-bypassed for the
    // same reasons as the toggle.
    const agentDefaultOn = agentModeFeatureEnabled && agentModeDefault === 'on' && !isRealSlashCommand;

    // Classifier wire-up - Layer-1-gated, opt-in via `agentModeDefault === 'auto'`.
    // Runs only on `'contextual'` queries where the rule-based router won't
    // already pick `agent_executor` (`'complex'`) or already short-circuit
    // (`'simple'` greetings etc.). Non-gated users never reach this branch.
    const promptHasAgentMention = prompt.includes('@');
    const promptHasAgentLiteral = hasExplicitAgentLiteral(prompt);
    const shortCircuit = evaluateShortCircuits({
      message: prompt,
      agentToggleEnabled: agentToggleActive || agentDefaultOn,
      hasAgentMention: promptHasAgentMention,
      hasAgentLiteral: promptHasAgentLiteral,
      model,
      isRealSlashCommand,
      disableAutoRouteForThisSession,
      intentClassifierAdminEnabled,
    });

    let classifierUpgraded = false;
    const classifierEligible =
      agentModeFeatureEnabled &&
      agentModeDefault === 'auto' &&
      complexity === 'contextual' &&
      !shortCircuit.shortCircuit;

    if (classifierEligible) {
      const outcome = await classifyIntent({
        userId,
        message: prompt,
        hasFileAttachments: sessionFabFileIdsForRouting.length + messageFileIdsForRouting.length > 0,
        hasAgentMention: promptHasAgentMention,
      });
      if (outcome.status === 'decided' && outcome.decision.useAgent && !outcome.shadowMode) {
        classifierUpgraded = true;
        perfLogger.log(
          `🧭 classifier upgraded → useAgent=true (model=${outcome.decision.classifierModel}, ` +
            `latency=${outcome.decision.latencyMs}ms, cacheHit=${outcome.decision.cacheHit})`
        );
      } else if (outcome.status === 'timeout') {
        perfLogger.log('🧭 classifier_timeout — falling through to rule-based routing');
      } else if (outcome.status === 'error') {
        perfLogger.log(`🧭 classifier error: ${outcome.message} — falling through`);
      }
    } else if (shortCircuit.shortCircuit) {
      perfLogger.log(`🧭 classifier short-circuit: ${shortCircuit.reason}`);
    }

    const userOverride: 'force_agent' | undefined =
      agentToggleActive || agentDefaultOn || classifierUpgraded ? 'force_agent' : undefined;
    // Heuristic auto-routing (`complexity === 'complex'` -> agent_executor) is
    // opt-in via the `'auto'` default - never the 'off' default or a bare
    // feature flag. Without this gate, a query the classifier deems 'complex'
    // (e.g. the recharts tool is enabled -> "generate random charts") dispatched
    // the executor while the composer toggle read OFF. Slash-command-bypassed
    // for the same reason as the toggle/default overrides above.
    //
    // Also honor the session-scoped opt-out. Dismissing the
    // AutoRouteBadge sets `disableAutoRouteForThisSession`, which already gates
    // the classifier path (via `evaluateShortCircuits`); mirror it here so the
    // same Dismiss actually stops the rule-based complexity reroute too -
    // otherwise the badge's Dismiss button is a no-op on the `complexity` path.
    const autoRouteEnabled =
      agentModeFeatureEnabled && agentModeDefault === 'auto' && !isRealSlashCommand && !disableAutoRouteForThisSession;
    const routeTarget = routeQuery({
      message: prompt,
      complexity,
      agentExecutorEnabled: isAgentsEnabled,
      userOverride,
      hasOrchestrationAgent: orchestrationAgent !== null,
      autoRouteEnabled,
    });
    perfLogger.log(
      `🧭 routeQuery → ${routeTarget} (complexity=${complexity}, toggle=${agentToggleActive}, ` +
        `default=${agentModeDefault}, classifier=${classifierUpgraded})`
    );

    // Provenance for the AutoRouteBadge and per-decision telemetry.
    // The precedence mirrors `routeQuery`'s order: explicit user signals
    // (mention / `@agent` literal / manual toggle) win over classifier
    // inference, which wins over the `'on'` user-default. Only meaningful
    // when the route actually lands on `agent_executor`.
    const routingSource = pickRoutingSource({
      routeTarget,
      orchestrationAgent,
      promptHasAgentLiteral,
      agentToggleActive,
      classifierUpgraded,
      agentDefaultOn,
      // Input for the rule-based complexity fallback (`autoRouteEnabled
      // && complexity === 'complex'` in routeQuery). This is just a signal, not
      // the verdict: `pickRoutingSource` returns `'complexity'` only when every
      // higher-precedence source misses. So `complexityUpgraded === true` does
      // NOT imply the complexity path won - e.g. with `agentModeDefault === 'on'`
      // a complex prompt still resolves to `'user-default'` (see
      // pickRoutingSource.test.ts). Precedence decides; this only feeds it.
      complexityUpgraded: complexity === 'complex',
    });
    // Local-only `effectiveAgentMode` - no Zustand write on the send hot path.
    // Nothing in the current UI reads `agentMode.source`; the value only
    // matters to the LLMCommand payload + WS dispatch, both threaded below.
    const effectiveAgentMode = routingSource ? { enabled: agentMode.enabled, source: routingSource } : agentMode;

    const llmSettings = assembleSettings({ stream, safeMaxTokens });
    const imageSettings: GenerateImageToolCall = {
      // Use primary model when user has selected an image model directly;
      // otherwise (text-model session using the image_generation tool) prefer
      // the @mentioned/dispatched agent's `preferredImageModel` override, then
      // fall back to the user's Smart Tools image selection. Mirrors how an
      // agent's `preferredModel` overrides the text model (#agent-mode-image-gen).
      // any: GenerateImageToolCall model type doesn't include all ImageModels variants
      model: (isImageModel(model)
        ? model
        : (orchestrationAgent ?? mentionedAgent)?.preferredImageModel || imageModel) as any,
      editModel: imageEditModel as any,
      size,
      quality,
      style,
      safety_tolerance,
      prompt_upsampling,
      seed,
      output_format,
    };

    const currentModelInfo = modelInfo?.find(m => m.id === model);
    // Tool-resolution ladder (model-capability gate -> Smart recommendations -> Fast ->
    // briefcase per-message override) extracted to useLLMSettingsAssembly.
    // A briefcase override requiring tools the model can't run REFUSES the send rather
    // than silently degrading to a tool-less send.
    const { effectiveTools, refused } = resolveTools({
      prompt,
      supportsTools: !!currentModelInfo?.supportsTools,
      toolsOverride: options?.toolsOverride,
    });
    if (refused) {
      setSubmitting(false);
      return;
    }

    // Warn if images are attached but model doesn't support vision
    const hasImageFiles =
      pendingMessageFiles.some(pf => pf.fabFile.mimeType?.startsWith('image/')) ||
      workBenchFiles.some(f => f.mimeType?.startsWith('image/'));
    if (hasImageFiles && currentModelInfo && !currentModelInfo.supportsVision) {
      toast.warning(
        `${currentModelInfo.name || model} does not support image input. Your images will not be visible to the model.`
      );
    }

    // Image-gen: a text-to-image-only model ('none' - no variation support and not a
    // required-input model like Kontext/Fill) can't use an attached image. The server
    // drops it and generates from the prompt alone, so warn rather than let it silently
    // vanish. (Vision above is the text-model case; this is the image-model case.)
    const hasWorkbenchImage = workBenchFiles.some(f => f.mimeType?.startsWith('image/'));
    if (
      hasWorkbenchImage &&
      currentModelInfo?.type === 'image' &&
      !currentModelInfo.supportsImageVariation &&
      !requiresImageInput(currentModelInfo.id)
    ) {
      toast.info(
        `${currentModelInfo.name || model} can't transform an attached image - generating from your prompt only.`
      );
    }

    let handler: (
      notebook: ISessionDocument | null
    ) => Promise<{ session: ISessionDocument; quest: IChatHistoryItemDocument } | void>;

    if (commandHandlers[command as CommandKey]) {
      const sessionFileIds = workBenchFiles.map(f => f.id);
      const messageLevelFileIds = sendableMessageFileIds.filter(id => !sessionFileIds.includes(id));

      handler = async notebook => {
        perfLogger.log('🧪 DEBUG AGENT DETECTION:');
        perfLogger.log('  - isAgentsEnabled:', isAgentsEnabled);
        perfLogger.log('  - Message contains @:', prompt.includes('@'));
        perfLogger.log('  - Full message:', prompt);

        return await handleCommand(commandHandlers, {
          userId,
          command,
          params,
          currentSession: notebook,
          model: model as any,
          workBenchFiles,
          sendJsonMessage,
          promptFileIds: messageLevelFileIds,
          optimisticSessionId: optimisticTmpId ?? undefined,
          enableQuestMaster: options?.forceEnableQuestMaster ?? isQuestMasterEnabled,
          enableMementos: isMementosEnabled,
          enableArtifacts: isArtifactsEnabled,
          enableAgents: isAgentsEnabled,
          enableLattice: isLatticeEnabled,
          queryClient,
          thinking,
          tools: effectiveTools,
          projectId,
          organizationId,
          researchMode,
          deepResearchConfig,
          imageConfig: imageSettings,
          modelConfigurations: accessibleModels,
          userTags,
          setChatCompletion,
          addMessageToSession,
          ...llmSettings,
          mcpServers: enabledMcpServers ?? undefined,
          // TODO: Remove this once. New one is in imageConfig
          size,
          quality,
          style,
          safety_tolerance,
          prompt_upsampling,
          seed,
          output_format,
        });
      };
    } else {
      const sessionFileIds = workBenchFiles.map(f => f.id);
      const messageLevelFileIds = sendableMessageFileIds.filter(id => !sessionFileIds.includes(id));

      handler = async notebook => {
        return await handleLLMCommand({
          userId,
          params: prompt,
          currentSession: notebook,
          model: model as ModelName,
          workBenchFiles,
          sendJsonMessage,
          promptFileIds: messageLevelFileIds,
          enableQuestMaster: options?.forceEnableQuestMaster ?? isQuestMasterEnabled,
          enableMementos: isMementosEnabled,
          enableArtifacts: isArtifactsEnabled,
          enableAgents: isAgentsEnabled,
          enableLattice: isLatticeEnabled,
          queryClient,
          thinking,
          tools: effectiveTools,
          projectId,
          organizationId,
          researchMode,
          deepResearchConfig,
          imageConfig: imageSettings,
          setChatCompletion,
          ...llmSettings,
          mcpServers: enabledMcpServers ?? undefined,
          optimisticSessionId: optimisticTmpId ?? undefined,
          // Forward Agent-mode state for telemetry / future server-side
          // routing. The chat completion path doesn't branch on this -
          // routeQuery has already steered us here when it's the intended
          // path - but we still surface the source so per-decision logs can
          // attribute the choice.
          agentMode: effectiveAgentMode,
        });
      };
    }

    // Optimistic pre-navigation: on /new, always create a fresh session immediately,
    // even if currentSession is stale from the previous route (useEffect cleanup runs
    // after render, so context may not be cleared yet when the user sends quickly).
    if (location.pathname === '/new') {
      isNewSession = true;
      const tmpId = createOptimisticSessionId();
      optimisticTmpId = tmpId;
      const now = new Date();

      const syntheticSession: ISessionDocument = {
        id: tmpId,
        name: 'New Notebook',
        userId: currentUser!.id,
        lastUpdated: now,
        firstCreated: now,
        createdAt: now,
        updatedAt: now,
        knowledgeIds: workBenchFiles.map(f => f.id),
        agentIds: workBenchAgents.map(a => a.id),
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [],
        groups: [],
      };

      // Store the message text and the tmpId so SessionContainer can (a) render
      // PendingFirstMessage immediately and (b) read the exact tmpId synchronously
      // from Zustand when session.created fires (avoids stale-ref migration bugs).
      setSessionLayout({ pendingFirstMessage: prompt, pendingOptimisticId: tmpId });

      // Seed session cache so NotebookPage's useGetSession won't 404-redirect back to /new.
      queryClient.setQueryData(['sessions', tmpId], syntheticSession);

      // Override any stale context and navigate before the API call returns.
      setCurrentSession(syntheticSession);
      setCurrentSessionId(tmpId);
      navigate({ to: '/notebooks/$id', params: { id: tmpId }, search: projectId ? { projectId } : {}, replace: true });

      // Force null so the backend creates a real session - the synthetic session is
      // client-side only and the backend must not receive the fake tmpId.
      sessionToSend = null;
    }

    // Routing: dispatch to the agent executor Lambda when `routeQuery`
    // resolves to `'agent_executor'`. The server validates `sessionId`
    // references a real Session document owned by the user (agentExecute.ts
    // L251), so the optimistic client-side ID won't work - we must create
    // the session first. The dispatch payload differs by mode:
    //   - With `orchestrationAgent`: use its preferred model + tool whitelist
    //     (preserves the earlier `@specific-agent` UX). A briefcase
    //     `toolsOverride` still wins the whitelist (see `enabledTools` below).
    //   - Without (toggle ON or `@agent` literal): dispatch agentless and let
    //     the executor build a synthetic profile from admin defaults.
    if (routeTarget === 'agent_executor') {
      try {
        // Prefer the dispatched agent's own text model - the orchestration
        // agent when present, else the first plain @mentioned agent - so a
        // personality-only agent runs on its `preferredModel` rather than the
        // caller's current selection. Mirrors the `agentId` and
        // `preferredImageModel` resolution above (#agent-mode-persona). Falls
        // back to the caller's `model` when neither agent pins one.
        const dispatchModel = (orchestrationAgent ?? mentionedAgent)?.preferredModel ?? (model as string);
        let dispatchSessionId = currentSessionId;
        if (!dispatchSessionId) {
          const realSession = await generateNewSession(
            prompt.slice(0, 60),
            workBenchFiles.map(f => f.id),
            workBenchAgents.map(a => a.id),
            projectId,
            dispatchModel
          );
          dispatchSessionId = realSession.id;
          setCurrentSession(realSession);
          setCurrentSessionId(realSession.id);
          // Insert into the sessions list cache so the new notebook appears
          // in the sidebar immediately. We bypass the `useGenerateNewSession`
          // mutation hook (which would do this for us) because the agent_execute
          // flow needs to chain the WS dispatch right after - calling the raw
          // `generateNewSession` API + manually updating the cache here is the
          // minimum viable equivalent. `keysAllowedToCreate` mirrors the hook
          // so the entry lands on the sidebar's `['sessions', 'own']` infinite
          // query without disturbing other session lists (shared, projects).
          updateAllQueryData(queryClient, 'sessions', 'write', realSession, {
            keysAllowedToCreate: [['sessions', 'own']],
          });
          // Match the invalidation set in `useGenerateNewSession.onSuccess`
          // (sessions.ts:643-651) so a session created via the agent_execute
          // flow refreshes the project view + activity feed identically to
          // one created via the canonical hook.
          if (projectId) {
            queryClient.invalidateQueries({ queryKey: ['sessions', 'projects', projectId] });
            queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
            queryClient.invalidateQueries({ queryKey: ['activities'] });
          }
          // Replace the optimistic URL the navigate-on-/new path already set.
          navigate({
            to: '/notebooks/$id',
            params: { id: realSession.id },
            search: projectId ? { projectId } : {},
            replace: true,
          });
        }

        // Evict prior runs from this session before dispatching a new one -
        // store would otherwise grow unbounded across a long-lived tab.
        useAgentExecutionStore.getState().clearForSession(dispatchSessionId);

        // Render the user's prompt as a message bubble above the iteration
        // stream. The agent executor doesn't create a Quest server-side
        // (it's fire-and-forget over WebSocket), so the normal chat-completion
        // optimistic-quest flow isn't triggered and the bubble would otherwise
        // never mount - leaving a confusing empty area above the permission
        // card. Optimistic-only is acceptable for now; refresh persistence
        // for agent executions is a follow-up.
        // Pass `routingSource` so the AutoRouteBadge renders live on the
        // optimistic bubble instead of waiting for the persisted Quest on reload.
        createOptimisticPromptBubble(queryClient, dispatchSessionId, prompt, routingSource);

        // Iteration cap comes from the agent doc; left unset when agentless so
        // the executor fills it from admin defaults.
        const thoroughness = orchestrationAgent?.defaultThoroughness ?? 'medium';
        const maxIters = orchestrationAgent?.maxIterations?.[thoroughness];
        // A briefcase `toolsOverride` wins the whitelist so an `@`-mention can't
        // drop the tools the prompt needs (see `resolveDispatchTools`).
        const enabledTools = resolveDispatchTools(
          options?.toolsOverride,
          effectiveTools,
          orchestrationAgent?.allowedTools
        );
        // Per-message file attachments - dedupe against the session-level set
        // so the same fabFileId isn't materialized twice into the first
        // iteration. Mirrors the dedup the `chat_completion` flow does in
        // `buildDataSources()`.
        const dispatchSessionFabFileIds = workBenchFiles.map(f => f.id);
        const dispatchMessageFileIds = sendableMessageFileIds.filter(id => !dispatchSessionFabFileIds.includes(id));
        agentExecution.start({
          sessionId: dispatchSessionId,
          // Server requires `questId`; without an authored quest we tag the
          // execution to the session itself so persistence groups iterations
          // under the right notebook.
          questId: dispatchSessionId,
          query: prompt,
          model: dispatchModel,
          organizationId: organizationId ?? undefined,
          // Forward the @mentioned agent's id so the executor injects its
          // persona and runs as that agent. Prefer the orchestration-configured
          // agent (carries tool whitelist + iteration caps); otherwise fall back
          // to the first plain @mentioned agent so a personality-only agent is
          // still run-as rather than ignored in favor of the synthetic default
          // (#agent-mode-persona / @-tag-enables-agent). Absent (no mention)
          // triggers the synthetic-profile path on the executor.
          agentId: orchestrationAgent?.id ?? mentionedAgent?.id,
          enabledTools,
          maxIterations: maxIters,
          // Knowledge / file context. Session-level knowledge is re-read from
          // the session document server-side; we forward the workbench snapshot
          // + per-message attachments here.
          sessionFabFileIds: dispatchSessionFabFileIds.length > 0 ? dispatchSessionFabFileIds : undefined,
          messageFileIds: dispatchMessageFileIds.length > 0 ? dispatchMessageFileIds : undefined,
          // LLM runtime knobs. `thinking` is forwarded only when the user
          // actually enabled it - the LLM store ships a baseline
          // `{enabled: false, ...}` that would otherwise round-trip needlessly.
          temperature: temperature ?? undefined,
          // `safeMaxTokens` (`useTokenLimits.ts`) only guards null/undefined,
          // so a persisted `0` / negative `max_tokens` would slip through and
          // fail the WS Zod `z.number().int().positive()` check - which throws
          // on `StartCommandSchema.parse` and silently rejects the whole
          // `agent_execute` dispatch. Forward only when strictly positive so
          // the executor falls back to its built-in default instead.
          maxTokens: safeMaxTokens > 0 ? safeMaxTokens : undefined,
          thinking: thinking?.enabled ? thinking : undefined,
          // Image config (#agent-mode-image-gen). Forwarded only when an image
          // model is resolvable so the executor's image_generation / edit_image
          // tools get a model instead of short-circuiting with "Image model
          // selection required" (no picker UI in a headless run). `imageSettings`
          // already folds in the dispatched agent's `preferredImageModel` (see
          // its construction above), and is baked into the persisted config so it
          // survives continuations. Never enters the ReActAgent context/checkpoint
          // (consumed only by buildSubagentToolConfig), so it can't reintroduce
          // the prior `structuredClone` failure.
          imageConfig: imageSettings.model ? imageSettings : undefined,
          // Memento parity with chat_completion. Mirrors the
          // `enableMementos: isMementosEnabled` payload field used by the
          // chat-completion dispatchers above so agent-mode runs evaluate
          // mementos on completion when the user has the feature enabled.
          enableMementos: isMementosEnabled,
          // Lattice parity with chat_completion. Mirrors the
          // `enableLattice: isLatticeEnabled` payload the chat-completion
          // dispatchers above send, so agent-mode runs get the same
          // context-window optimization when the user has the feature on.
          enableLattice: isLatticeEnabled,
          // Propagate provenance so persisted IChatHistoryItem carries the
          // tag the AutoRouteBadge reads.
          routingSource,
        });
        setChatInputValue('');
        clearDraft(dispatchSessionId);
        // A first send from a new notebook drafted under the new-notebook key
        // (currentSessionId was null); clear it too so the sent text can't
        // resurface in a later new notebook if the composer remounts mid-resolve.
        clearDraft(NEW_NOTEBOOK_DRAFT_KEY);
        if (chatInputRef.current) chatInputRef.current.value = '';
        setPendingMessageFiles([]);
        setSubmitting(false);
        return undefined;
      } catch (error) {
        // Orchestration dispatch failed before `agent_execute` was sent
        // (most likely `generateNewSession` threw). Roll back optimistic
        // state and surface the failure so the input doesn't stay stuck
        // in a "sending..." state with no user feedback.
        console.error('Orchestration dispatch failed:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to start agent execution');
        if (isNewSession && optimisticTmpId) {
          cleanupOptimistic(optimisticTmpId);
          setSessionLayout({ pendingFirstMessage: null, pendingOptimisticId: null });
          setCurrentSession(null);
          setCurrentSessionId(null);
          navigate({ to: '/new', search: projectId ? { projectId } : {}, replace: true });
        }
        setWorkBenchAgents([]);
        setSubmitting(false);
        return undefined;
      }
    }

    // Clear input optimistically before the API call returns
    resetLastJsonMessage();
    setChatInputValue('');
    if (currentSessionId) {
      clearDraft(currentSessionId);
    }
    // Also drop the new-notebook draft: a first send starts with a null
    // currentSessionId, so the guarded clear above misses the key the text was
    // saved under, and it would otherwise resurface in a later new notebook.
    clearDraft(NEW_NOTEBOOK_DRAFT_KEY);
    if (chatInputRef.current) {
      chatInputRef.current.value = '';
    }
    setPendingMessageFiles([]);

    // Optimistic generating indicator. Flip `chatCompletion` into an active
    // state synchronously so `shouldShowStopButton` becomes true on the same
    // frame as the click - without it, the user sees no affordance until the
    // WS handler's first event (up to ~13s on a Lambda cold start). The real
    // stream replaces `statusMessage` on its first update; the error path below
    // clears it if no stream ever lands.
    //
    // Skipped for real slash commands (`/roll`, `/gen_image`, `/gen_video`,
    // etc.) - those handlers don't emit `streamed_chat_completion` WS events,
    // so the sentinel would never be overwritten on success and the Stop
    // button would stay stuck after the command returned. `handleLLMCommand`
    // is the only path the chat-completion WS subscription drives.
    //
    // Also clear `prev.quest` so `SessionMiddle`'s `streamingMessageData`
    // doesn't briefly re-render a previously completed quest as "streaming"
    // during the cold-start window (the `completed` guard there falls open
    // the moment we flip `completed: false` on a stale `prev.quest`).
    if (!isRealSlashCommand) {
      setChatCompletion(prev => ({
        ...prev,
        quest: undefined,
        completed: false,
        stopped: false,
        statusMessage: OPTIMISTIC_GENERATING_STATUS,
      }));
    }

    let data;
    try {
      data = await handler(sessionToSend);
    } catch (error: unknown) {
      console.error('Error sending message:', error);
      // Error toasts are handled in LLMCommand.tsx / ImageGenerationCommand.ts.
      // Do NOT tear down the optimistic session here - `createOptimisticQuest`
      // (llm.ts) has already written a `**Error:** ...` reply into the quests
      // cache for the user to see. Previously the new-session branch removed
      // the synthetic session and navigated back to `/new`, discarding that
      // error from view and leaving the user with only a briefly-flashed toast.
      // The optimistic session document stays in cache so `NotebookPage` keeps
      // rendering; `SessionMiddle` clears the `pendingFirstMessage` overlay once
      // the failed quest lands in `flattenQuests`, so the chat shows prompt +
      // error reply in context.
      setWorkBenchAgents([]);
      setSubmitting(false);
      // Roll back the optimistic Stop affordance only when no real stream
      // event landed - `statusMessage` strict-equals the sentinel iff the WS
      // handler never overwrote it. Leaves a real in-flight stream untouched.
      setChatCompletion(prev =>
        prev.statusMessage === OPTIMISTIC_GENERATING_STATUS
          ? { ...prev, completed: true, statusMessage: undefined }
          : prev
      );
      return;
    }

    setWorkBenchAgents([]);
    setSubmitting(false);

    // Fallback migration: if session.created websocket was missed (e.g. WS not yet
    // connected in a fresh session), the optimistic ID is still set. Use the API
    // response to perform the same cache migration that session.created would have.
    if (isNewSession && optimisticTmpId && data?.session?.id) {
      const { pendingOptimisticId } = useSessionLayout.getState();
      if (pendingOptimisticId && pendingOptimisticId !== data.session.id) {
        const realId = data.session.id;
        migrateQuests(optimisticTmpId, realId);
        migrateSession(optimisticTmpId, realId, data.session);
        setCurrentSessionId(realId);
        setCurrentSession(data.session);
        setSessionLayout({ pendingFirstMessage: null, pendingOptimisticId: null });
        navigate({ to: '/notebooks/$id', params: { id: realId }, replace: true });
      }
    }

    if (isQuestMasterEnabled) {
      setLLM({ isQuestMasterEnabled: false });
    }

    if (data?.session.id) {
      recordSessionActivity(data.session.id);
    }

    clearFiles();

    // Hide keyboard after sending message (mobile)
    setTimeout(() => {
      lexicalInputRef.current?.blur();
    }, 100);
  };

  // Auto-submit quest goal when websocket is ready (from /quests New Quest modal)
  useEffect(() => {
    if (pendingAutoSubmitGoal && readyState === ReadyState.OPEN && !submitting) {
      console.log('🚀 Auto-submitting quest goal:', pendingAutoSubmitGoal, 'enableQM:', enableQuestMasterOnSubmit);
      const goal = pendingAutoSubmitGoal;
      const shouldEnableQM = enableQuestMasterOnSubmit;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingAutoSubmitGoal(null);

      setEnableQuestMasterOnSubmit(false);
      setTimeout(() => {
        handleSendClick(goal, { forceEnableQuestMaster: shouldEnableQM });
      }, 150);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoSubmitGoal, readyState, submitting, enableQuestMasterOnSubmit]);

  // Programmatic submit + briefcase launch handling, extracted to a dedicated
  // hook. Owns the /opti null-session guard, nonce dedup, and timer cleanup.
  useProgrammaticSubmit({ handleSendClick, readyState, submitting, currentSession });

  return { submitting, stoppingMessage, pendingAutoSubmitGoal, handleSendClick, handleStopMessage };
}
