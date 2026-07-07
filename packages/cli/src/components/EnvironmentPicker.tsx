import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { LOCAL_DEV_URL, parseApiUrl } from '../utils/apiUrl.js';

/**
 * First-run backend selection. Shown when the CLI starts with no endpoint
 * configured (a published, unbranded fork with no baked default) so the user
 * chooses where to connect instead of hitting a dead end. The choice maps
 * directly onto {@link ConfigStore.switchApiEnvironment}'s target argument.
 *
 * There is deliberately no "hosted service" option: this picker only renders
 * when the endpoint is unconfigured, which by definition means no baked default
 * exists (see resolveApiEndpoint). A branded build always resolves to its baked
 * default and never reaches here, so the only reachable choices are the local
 * dev server and a custom/self-hosted URL.
 */
export type EnvChoice = { target: 'dev' } | { target: { customUrl: string } };

type MenuValue = 'dev' | 'custom';

interface EnvironmentPickerProps {
  onSelect: (choice: EnvChoice) => void;
}

export function EnvironmentPicker({ onSelect }: EnvironmentPickerProps) {
  const [phase, setPhase] = useState<'menu' | 'custom'>('menu');
  const [customValue, setCustomValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const items: { label: string; value: MenuValue }[] = [
    { label: `Local dev server (${LOCAL_DEV_URL})`, value: 'dev' },
    { label: 'Custom / self-hosted URL…', value: 'custom' },
  ];

  const handleMenuSelect = (item: { value: MenuValue }) => {
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
