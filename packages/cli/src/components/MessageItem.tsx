import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../storage';
import type { AgentStep } from '@bike4mind/agents';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useStdoutDimensions } from '../hooks/useStdoutDimensions.js';

/**
 * Truncates a value to maxLength, converting objects to JSON strings.
 * Appends '...' if truncated.
 */
function truncateValue(value: unknown, maxLength: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '...';
}

interface MessageItemProps {
  message: Message;
  /** When false, the agent's thought steps are suppressed in the action trace. Defaults to true. */
  showThoughts?: boolean;
}

// Tools whose arguments are noisy (large old_string/new_string diffs etc.)
// and add nothing the user needs in the chat trace - the Result line
// already shows whether the edit succeeded.
const TOOLS_WITH_HIDDEN_ARGS = new Set(['edit_local_file']);

export const MessageItem = React.memo(function MessageItem({ message, showThoughts = true }: MessageItemProps) {
  const isUser = message.role === 'user';
  const [terminalCols] = useStdoutDimensions();

  // User-message highlight needs to fill the full row. We tried Yoga
  // `width="100%"` + Box backgroundColor - works in <Static> but not in
  // the live frame (different layout context, computed width comes out
  // smaller than terminal width). The reliable approach is to pad the
  // text content with literal spaces and put backgroundColor on the
  // <Text> itself.
  const userPromptText = `❯ ${message.content}`;
  const paddedUserPromptText =
    userPromptText.length >= terminalCols ? userPromptText : userPromptText.padEnd(terminalCols);

  return (
    <Box flexDirection="column">
      {isUser && message.content && (
        <Box marginBottom={1}>
          <Text backgroundColor="whiteBright" color="black">
            {paddedUserPromptText}
          </Text>
        </Box>
      )}

      {/* Show detailed tool execution history FIRST (before final answer) */}
      {/* Show for both pending and completed messages */}
      {!isUser &&
        message.metadata?.steps &&
        message.metadata.steps.filter(s => (showThoughts && s.type === 'thought') || s.type === 'action').length >
          0 && (
          <Box paddingLeft={2} flexDirection="column" marginBottom={1}>
            {message.metadata.steps
              .map((step: AgentStep, idx: number) => {
                if (step.type === 'thought') {
                  if (!showThoughts) return null;
                  return (
                    <Box key={idx} marginTop={1} flexDirection="column">
                      <Text dimColor>{`💭 ${step.content}`}</Text>
                    </Box>
                  );
                }

                if (step.type === 'action') {
                  const toolName = step.metadata?.toolName || 'unknown';
                  // Convert snake_case to Title Case (e.g., edit_local_file -> Edit Local File)
                  const formattedToolName = toolName
                    .split('_')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');
                  const toolInput = step.metadata?.toolInput;
                  const hideArgs = TOOLS_WITH_HIDDEN_ARGS.has(toolName);
                  const observationStep = message.metadata?.steps?.[idx + 1];
                  const result = observationStep?.type === 'observation' ? observationStep.content : null;

                  return (
                    <Box key={idx} marginTop={1} flexDirection="column">
                      <Box>
                        <Text color="yellow">{formattedToolName}</Text>
                        {toolInput && !hideArgs && <Text dimColor>{` • ${truncateValue(toolInput, 100)}`}</Text>}
                      </Box>
                      {result && (
                        <Box paddingLeft={2}>
                          <Text dimColor>{`Result: ${truncateValue(result, 200)}`}</Text>
                        </Box>
                      )}
                    </Box>
                  );
                }

                return null;
              })
              .filter(Boolean)}
          </Box>
        )}

      {/* Final answer / message content (shown AFTER reasoning trace) */}
      {/* Don't show '...' for pending messages, and don't show for user messages (handled above) */}
      {!isUser && message.content !== '...' && (
        <Box paddingLeft={2} marginBottom={1}>
          {message.metadata?.permissionDenied ? (
            <Text color="yellow">⚠️ {message.content}</Text>
          ) : (
            <MarkdownRenderer content={message.content} />
          )}
        </Box>
      )}

      {/* Show usage metrics (tokens and credits) after assistant message */}
      {!isUser && message.content !== '...' && message.metadata && (
        <Box paddingLeft={2} marginBottom={1}>
          {(message.metadata.tokenUsage?.total || message.metadata.creditsUsed) && (
            <Text dimColor>
              {'('}
              {message.metadata.tokenUsage?.total ? `${message.metadata.tokenUsage.total.toLocaleString()} tokens` : ''}
              {message.metadata.creditsUsed && message.metadata.creditsUsed > 0
                ? (message.metadata.tokenUsage?.total ? ' • ' : '') +
                  `used ${message.metadata.creditsUsed.toLocaleString()} ${message.metadata.creditsUsed === 1 ? 'credit' : 'credits'}`
                : ''}
              {')'}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
});
