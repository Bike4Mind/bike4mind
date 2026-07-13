import React from 'react';
import { Box, Text } from 'ink';
import { useCliStore } from '../store';

interface StatusBarProps {
  isBashMode: boolean;
  model: string;
  tokenUsage: number;
  creditsUsage?: number;
  /** Spawned-agent tokens: session rollup plus live usage of running agents */
  subagentTokens?: number;
  /** Spawned-agent credits: session rollup plus live usage of running agents */
  subagentCredits?: number;
  /** True while at least one spawned agent is running (live-updating value) */
  subagentActive?: boolean;
}

export const StatusBar = React.memo(function StatusBar({
  isBashMode,
  model,
  tokenUsage,
  creditsUsage,
  subagentTokens = 0,
  subagentCredits = 0,
  subagentActive = false,
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
        {(subagentTokens > 0 || subagentActive) && (
          <Text color={subagentActive ? 'cyan' : undefined} dimColor={!subagentActive}>
            agents: {subagentTokens.toLocaleString()} tokens
            {subagentCredits > 0 ? ` / ${subagentCredits.toLocaleString()} credits` : ''}
          </Text>
        )}
        <Text dimColor>{model}</Text>
      </Box>
    </Box>
  );
});
