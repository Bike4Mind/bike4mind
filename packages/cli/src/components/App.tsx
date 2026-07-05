import React, { useState, useEffect } from 'react';
import { Box, Text, Static, useInput, useStdout } from 'ink';
import { StatusBar } from './StatusBar';
import { InputPrompt } from './InputPrompt';
import { AgentThinking } from './AgentThinking';
import { BackgroundAgentStatus } from './BackgroundAgentStatus';
import { CompletedGroupNotification } from './CompletedGroupNotification';
import { PermissionPrompt } from './PermissionPrompt';
import type { PermissionResponse } from './PermissionPrompt';
import { UserQuestionPrompt } from './UserQuestionPrompt';
import type { UserQuestionResponse } from '@bike4mind/services';
import { ReviewGatePrompt } from './ReviewGatePrompt';
import { ExitHandoffPrompt } from './ExitHandoffPrompt';
import { ConfigEditor } from './ConfigEditor';
import { McpViewer } from './McpViewer';
import { MessageItem } from './MessageItem';
import { useCliStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import type { CliConfig } from '../storage';
import { ChatModels, type ModelInfo } from '@bike4mind/common';
import type { McpManager } from '../utils/mcpAdapter';
import { processFileReferences, hasFileReferences } from '../utils/processFileReferences.js';
import type { CommandDefinition } from '../config/commands.js';

interface AppProps {
  onMessage: (message: string) => Promise<void>;
  onBackgroundCompletion?: () => Promise<void>; // Silent handler for background agent results
  onCommand: (command: string, args: string[]) => Promise<void>;
  onBashCommand: (command: string) => void;
  onPermissionResponse: (response: PermissionResponse, promptId: string) => void;
  onUserQuestionResponse: (response: UserQuestionResponse, promptId: string) => void;
  onReviewGateResponse: (response: { decision: 'approved' | 'rejected'; note?: string }, promptId: string) => void;
  onImageDetected?: (imageData: Buffer) => Promise<string>;
  commandHistory?: string[];
  commands?: CommandDefinition[]; // Merged built-in + custom commands
  config?: CliConfig;
  availableModels?: ModelInfo[];
  onSaveConfig?: (config: CliConfig) => Promise<void>;
  prefillInput?: string; // Pre-fill input (e.g., from rewind)
  onPrefillConsumed?: () => void; // Called after prefill is applied
  mcpManager?: McpManager; // MCP manager for server status
}

export function App({
  onMessage,
  onBackgroundCompletion,
  onCommand,
  onBashCommand,
  onPermissionResponse,
  onUserQuestionResponse,
  onReviewGateResponse,
  onImageDetected,
  commandHistory = [],
  commands = [],
  config,
  availableModels = [],
  onSaveConfig,
  prefillInput,
  onPrefillConsumed,
  mcpManager,
}: AppProps) {
  // Subscribe only to the specific fields needed, not the whole session, to avoid re-renders.
  const messages = useCliStore(useShallow(state => state.session?.messages || []));
  const pendingMessages = useCliStore(state => state.pendingMessages);
  const messageQueue = useCliStore(state => state.messageQueue);
  const currentModel = useCliStore(state => state.session?.model || ChatModels.CLAUDE_4_5_SONNET);
  const totalTokens = useCliStore(state => state.session?.metadata.totalTokens || 0);
  const totalCredits = useCliStore(state => state.session?.metadata.totalCredits);
  const isThinking = useCliStore(state => state.isThinking);
  const permissionPrompt = useCliStore(state => state.permissionPrompt);
  const userQuestionPrompt = useCliStore(state => state.userQuestionPrompt);
  const reviewGatePrompt = useCliStore(state => state.reviewGatePrompt);
  const exitHandoffPrompt = useCliStore(state => state.exitHandoffPrompt);
  const setExitHandoffPrompt = useCliStore(state => state.setExitHandoffPrompt);
  const showConfigEditor = useCliStore(state => state.showConfigEditor);
  const setShowConfigEditor = useCliStore(state => state.setShowConfigEditor);
  const showMcpViewer = useCliStore(state => state.showMcpViewer);
  const setShowMcpViewer = useCliStore(state => state.setShowMcpViewer);
  const exitRequested = useCliStore(state => state.exitRequested);
  const setIsThinking = useCliStore(state => state.setIsThinking);
  const pendingBackgroundTrigger = useCliStore(state => state.pendingBackgroundTrigger);
  const setPendingBackgroundTrigger = useCliStore(state => state.setPendingBackgroundTrigger);

  // Auto-trigger agent when background tasks complete while idle
  useEffect(() => {
    if (pendingBackgroundTrigger && !isThinking && onBackgroundCompletion) {
      // Clear the trigger immediately to prevent re-triggering
      setPendingBackgroundTrigger(false);
      // Trigger silent handler to process background results (no user message added)
      onBackgroundCompletion();
    }
  }, [pendingBackgroundTrigger, isThinking, setPendingBackgroundTrigger, onBackgroundCompletion]);

  // Interaction mode cycle (normal -> auto-accept -> plan -> normal)
  const cycleInteractionMode = useCliStore(state => state.cycleInteractionMode);

  // Shift+Tab cycles the interaction mode (always active)
  useInput((_input, key) => {
    if (key.tab && key.shift) {
      cycleInteractionMode();
    }
  });

  // Bash mode state for border color
  const [isBashMode, setIsBashMode] = useState(false);

  // Agent thought visibility (default shown - user can hide via config)
  const showThoughts = config?.preferences.showThoughts ?? true;

  // Terminal width - needed to pad queued-message rows so the background
  // color fills the entire row (same pattern as the sent user-prompt
  // highlight in MessageItem.tsx).
  const { stdout } = useStdout();
  const terminalCols = stdout?.columns ?? 80;

  const handleSubmit = React.useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;

      // Handle commands (but not file paths like /Users/...)
      // Commands are single words after /, file paths have multiple path segments
      if (trimmed.startsWith('/') && !trimmed.match(/^\/[A-Z]/)) {
        const [command, ...args] = trimmed.slice(1).split(' ');
        await onCommand(command, args);
        return;
      }

      // Bare `exit`/`quit` (no slash) - quit the REPL, matching the
      // convention of node, python, psql, and redis-cli. Only an exact,
      // lone word triggers this; anything longer is a normal message so a
      // user can still ask the agent something like "how do I exit vim".
      if (trimmed === 'exit' || trimmed === 'quit') {
        await onCommand(trimmed, []);
        return;
      }

      // Process file references if present (do this before queueing so the
      // resolved file content is captured at submit time).
      let messageToSend = trimmed;
      if (hasFileReferences(trimmed)) {
        const processed = await processFileReferences(trimmed);
        messageToSend = processed.content;
        if (processed.errors.length > 0) {
          const errorBlock = processed.errors.map(e => `[Warning: ${e}]`).join('\n');
          messageToSend = `${messageToSend}\n\n${errorBlock}`;
        }
      }

      // If the agent is already processing a message, enqueue this one and
      // return. The handleMessage finally block drains the queue. This is
      // what lets the user keep typing/submitting while a long response is
      // still in flight.
      if (useCliStore.getState().isThinking) {
        useCliStore.getState().enqueueMessage(messageToSend);
        return;
      }

      setIsThinking(true);
      try {
        // Agent steps are captured from result.steps after completion
        // No need to track during execution (prevents re-renders)
        await onMessage(messageToSend);
      } finally {
        setIsThinking(false);
      }
    },
    [onMessage, onCommand, setIsThinking]
  );

  return (
    <Box flexDirection="column" height="100%">
      {/* Config Editor - full screen takeover */}
      {showConfigEditor && config && onSaveConfig ? (
        <Box flexDirection="column" paddingX={1}>
          <ConfigEditor
            config={config}
            availableModels={availableModels}
            onSave={onSaveConfig}
            onClose={() => setShowConfigEditor(false)}
          />
        </Box>
      ) : showMcpViewer && config ? (
        /* MCP Viewer - full screen takeover */
        <Box flexDirection="column" paddingX={1}>
          <McpViewer config={config} mcpManager={mcpManager} onClose={() => setShowMcpViewer(false)} />
        </Box>
      ) : (
        <>
          {/* HISTORY MESSAGES — rendered via <Static> so each message is
              written to terminal scrollback once and never re-rendered.
              The user gets native terminal mouse-wheel scrollback for
              free. Trade-off: Ink 7.0.1 has a known resize-render bug
              where widening the terminal can leave ghost frames in
              scrollback. Re-evaluate when upgrading Ink. */}
          <Static items={messages}>
            {message => (
              <Box key={message.id} flexDirection="column">
                <MessageItem message={message} showThoughts={showThoughts} />
              </Box>
            )}
          </Static>

          <Box flexDirection="column">
            {/* PENDING MESSAGES - Dynamic rendering (updates in real-time) */}
            <Box flexDirection="column">
              {pendingMessages.map(message => (
                <Box key={message.id} flexDirection="column">
                  <MessageItem message={message} showThoughts={showThoughts} />
                </Box>
              ))}
            </Box>

            {/* Permission Prompt - rendered alongside messages, not instead of them */}
            {/* Key forces React to unmount/remount when switching between queued prompts,
                ensuring SelectInput re-initializes keyboard handling for each new prompt */}
            {permissionPrompt && (
              <Box key={permissionPrompt.id} flexDirection="column" paddingX={1}>
                <PermissionPrompt
                  toolName={permissionPrompt.toolName}
                  args={permissionPrompt.args}
                  preview={permissionPrompt.preview}
                  canBeTrusted={permissionPrompt.canBeTrusted}
                  // Capture the id at render time so the response carries the
                  // prompt it was rendered against - closes the tavern/Ink race
                  // where a buffered keypress for the active prompt could land
                  // after the tavern dequeued it and made the next prompt active.
                  onResponse={response => onPermissionResponse(response, permissionPrompt.id)}
                />
              </Box>
            )}

            {/* User question prompt */}
            {userQuestionPrompt && (
              <Box key={userQuestionPrompt.id} flexDirection="column" paddingX={1}>
                <UserQuestionPrompt
                  payload={userQuestionPrompt.payload}
                  onResponse={response => onUserQuestionResponse(response, userQuestionPrompt.id)}
                />
              </Box>
            )}

            {/* Review gate prompt */}
            {reviewGatePrompt && (
              <Box key={reviewGatePrompt.id} flexDirection="column" paddingX={1}>
                <ReviewGatePrompt
                  description={reviewGatePrompt.description}
                  options={reviewGatePrompt.options}
                  recommendation={reviewGatePrompt.recommendation}
                  onResponse={response => onReviewGateResponse(response, reviewGatePrompt.id)}
                />
              </Box>
            )}

            {/* Exit-time handoff prompt */}
            {exitHandoffPrompt && (
              <Box key={exitHandoffPrompt.id} flexDirection="column" paddingX={1}>
                <ExitHandoffPrompt
                  onResponse={generate => {
                    const target = exitHandoffPrompt;
                    setExitHandoffPrompt(null);
                    target.resolve(generate);
                  }}
                />
              </Box>
            )}

            {/* Agent thinking display - hidden when an interactive prompt is active */}
            {!permissionPrompt && !userQuestionPrompt && !reviewGatePrompt && !exitHandoffPrompt && <AgentThinking />}

            {/* Background agent status */}
            <BackgroundAgentStatus />

            {/* Completed group notifications - shown when all agents in a group finish */}
            <CompletedGroupNotification />

            {/* Exit warning */}
            {exitRequested && (
              <Box paddingX={1} marginBottom={1}>
                <Text color="yellow" bold>
                  Press Ctrl+C again to exit
                </Text>
              </Box>
            )}
          </Box>

          {/* FIXED INPUT AREA - stays at bottom, doesn't scroll */}
          <Box flexDirection="column" flexShrink={0}>
            {/* Queued user messages — shown above the input box while the
                agent is processing a previous message. Each entry drains
                top-down and gets removed from this list as it starts
                running. Styled with a gray bg + white text to read as
                "pending" without being too prominent — distinct from the
                whiteBright bg used for already-sent user prompts. Each
                row is padded to terminal width so the bg fills the row,
                matching the sent-prompt highlight pattern. */}
            {messageQueue.length > 0 && (
              <Box flexDirection="column" paddingX={1} marginBottom={1}>
                {messageQueue.map((queuedMessage, idx) => {
                  const rowText = `❯ ${queuedMessage}`;
                  const padded = rowText.length >= terminalCols - 2 ? rowText : rowText.padEnd(terminalCols - 2);
                  return (
                    <Text key={idx} backgroundColor="gray" color="white" wrap="truncate-end">
                      {padded}
                    </Text>
                  );
                })}
              </Box>
            )}

            {/* Input prompt */}
            <Box
              borderStyle="single"
              borderColor={isBashMode ? 'yellow' : 'cyan'}
              borderTop
              borderBottom
              borderLeft={false}
              borderRight={false}
            >
              <InputPrompt
                onSubmit={handleSubmit}
                onBashCommand={onBashCommand}
                onImageDetected={onImageDetected}
                disabled={!!permissionPrompt || !!userQuestionPrompt || !!reviewGatePrompt || !!exitHandoffPrompt}
                history={commandHistory}
                commands={commands}
                prefillInput={prefillInput}
                onPrefillConsumed={onPrefillConsumed}
                onBashModeChange={setIsBashMode}
              />
            </Box>
            {/* Status bar - below input prompt */}
            <StatusBar
              isBashMode={isBashMode}
              model={currentModel}
              tokenUsage={totalTokens}
              creditsUsage={totalCredits}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
