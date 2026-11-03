import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { getDefaultApiUrl, LOCAL_DEV_URL, parseApiUrl } from '../utils/apiUrl.js';

const NoIndicator = () => null;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * First-run backend selection. Shown when the CLI starts with no saved endpoint
 * or sign-in, or with no endpoint at all (an unbranded fork with no baked
 * default). The choice maps directly onto {@link ConfigStore.switchApiEnvironment}'s
 * target argument.
 *
 * The build-time default service (when baked in) is offered first and preselected;
 * it is labelled by host so no brand literal lives in source.
 */
export type EnvChoice = { target: 'prod' } | { target: 'dev' } | { target: { customUrl: string } };

type MenuValue = 'prod' | 'dev' | 'custom';

interface EnvironmentPickerProps {
  onSelect: (choice: EnvChoice) => void;
  defaultUrl?: string;
}

export function EnvironmentPicker({ onSelect, defaultUrl = getDefaultApiUrl() }: EnvironmentPickerProps) {
  const [phase, setPhase] = useState<'menu' | 'custom'>('menu');
  const [customValue, setCustomValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const items: { label: string; value: MenuValue }[] = [
    ...(defaultUrl ? [{ label: `Hosted (${hostOf(defaultUrl)})`, value: 'prod' as const }] : []),
    { label: `Local dev server (${LOCAL_DEV_URL})`, value: 'dev' },
    { label: 'Custom / self-hosted URL…', value: 'custom' },
  ];

  const handleMenuSelect = (item: { value: MenuValue }) => {
    if (item.value === 'prod') {
      onSelect({ target: 'prod' });
      return;
    }
    if (item.value === 'dev') {
      onSelect({ target: 'dev' });
      return;
    }
    setPhase('custom');
  };

  const handleCustomSubmit = (raw: string) => {
    const result = parseApiUrl(raw);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onSelect({ target: { customUrl: result.url } });
  };

  if (phase === 'custom') {
    return (
      <Box flexDirection="column" marginY={1}>
        <Box marginBottom={1}>
          <Text bold>Enter the API URL for your instance:</Text>
        </Box>
        <Box>
          <Text color="cyan">❯ </Text>
          <TextInput
            value={customValue}
            onChange={value => {
              setCustomValue(value);
              if (error) setError(null);
            }}
            onSubmit={handleCustomSubmit}
            placeholder="https://app.example.com"
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to confirm, Ctrl+C to cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1}>
        <Text bold>🌍 Where should b4m connect?</Text>
      </Box>

      <SelectInput
        items={items}
        onSelect={handleMenuSelect}
        indicatorComponent={NoIndicator}
        itemComponent={({ isSelected, label }) => (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '❯ ' : '  '}
              {label}
            </Text>
          </Box>
        )}
      />

      <Box marginTop={1}>
        <Text dimColor>Use ↑↓ arrows to navigate, Enter to select, Ctrl+C to cancel</Text>
      </Box>
    </Box>
  );
}
