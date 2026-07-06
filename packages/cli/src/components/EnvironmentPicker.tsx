import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { LOCAL_DEV_URL } from '../utils/apiUrl.js';

/**
 * First-run backend selection. Shown when the CLI starts with no endpoint
 * configured (a published, unbranded fork with no baked default) so the user
 * chooses where to connect instead of hitting a dead end. The choice maps
 * directly onto {@link ConfigStore.switchApiEnvironment}'s target argument.
 */
export type EnvChoice = { target: 'prod' } | { target: 'dev' } | { target: { customUrl: string } };

type MenuValue = 'prod' | 'dev' | 'custom';

interface EnvironmentPickerProps {
  /** The baked-in hosted service URL, if this build has one. Omitted for an unbranded fork. */
  bakedDefaultUrl?: string;
  onSelect: (choice: EnvChoice) => void;
}

/**
 * Normalize and validate a user-entered API URL. Mirrors the `--api-url`
 * validation in apiCommand.ts: trims, strips trailing slashes, and requires an
 * http(s) origin. Exported for unit testing.
 */
export function validateApiUrlInput(raw: string): { url: string } | { error: string } {
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) {
    return { error: 'Please enter a URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Only http:// and https:// URLs are supported (got ${parsed.protocol}//)` };
  }

  return { url };
}

export function EnvironmentPicker({ bakedDefaultUrl, onSelect }: EnvironmentPickerProps) {
  const [phase, setPhase] = useState<'menu' | 'custom'>('menu');
  const [customValue, setCustomValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const items: { label: string; value: MenuValue }[] = [];
  if (bakedDefaultUrl) {
    items.push({ label: `Hosted service (${bakedDefaultUrl})`, value: 'prod' });
  }
  items.push({ label: `Local dev server (${LOCAL_DEV_URL})`, value: 'dev' });
  items.push({ label: 'Custom / self-hosted URL…', value: 'custom' });

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
    const result = validateApiUrlInput(raw);
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
