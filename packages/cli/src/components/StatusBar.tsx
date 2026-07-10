import React from 'react';
import { Box, Text } from 'ink';
import { useCliStore } from '../store';

interface StatusBarProps {
  isBashMode: boolean;
  model: string;
  tokenUsage: number;
  creditsUsage?: number;
  /** Aggregate tokens consumed by spawned subagents this session (separate from tokenUsage) */
  subagentTokenUsage?: number;
  /** Aggregate credits consumed by spawned subagents this session (best-effort, see subagentCost) */
  subagentCreditsUsage?: number;
}

export const StatusBar = React.memo(function StatusBar({
  isBashMode,
  model,
  tokenUsage,
  creditsUsage,
  subagentTokenUsage,
  subagentCreditsUsage,
}: StatusBarProps) {
  const interactionMode = useCliStore(state => state.interactionMode);

  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%" paddingX={1}>
      <Box gap={2}>
        {isBashMode ? (
          <Text color="yellow" bold>
            BASH
          </Text>
        ) : null}
        {interactionMode === 'auto-accept' && (
          <Text color="green" bold>
            AUTO ACCEPT: Edits
          </Text>
        )}
        {interactionMode === 'plan' && (
          <Text color="yellow" bold>
            PLAN MODE
          </Text>
        )}
      </Box>
      <Box gap={2}>
        {tokenUsage > 0 && <Text dimColor>{tokenUsage.toLocaleString()} tokens</Text>}
        {creditsUsage !== undefined && creditsUsage > 0 && (
          <Text dimColor>
            {creditsUsage.toLocaleString()} {creditsUsage === 1 ? 'credit' : 'credits'}
          </Text>
        )}
        {subagentTokenUsage !== undefined && subagentTokenUsage > 0 && (
          <Text dimColor>+{subagentTokenUsage.toLocaleString()} agent tokens</Text>
        )}
        {subagentCreditsUsage !== undefined && subagentCreditsUsage > 0 && (
          <Text dimColor>+{subagentCreditsUsage.toLocaleString()} agent credits</Text>
        )}
        <Text dimColor>{model}</Text>
      </Box>
    </Box>
  );
});
