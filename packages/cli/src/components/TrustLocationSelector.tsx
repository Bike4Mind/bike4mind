import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

interface TrustLocationSelectorProps {
  inProject: boolean;
  onSelect: (location: 'local' | 'project' | 'global') => void;
  onCancel: () => void;
}

type TrustLocationItem = {
  label: string;
  value: 'local' | 'project' | 'global';
};

export function TrustLocationSelector({ inProject, onSelect, onCancel }: TrustLocationSelectorProps) {
  const items: TrustLocationItem[] = [];

  if (inProject) {
    items.push({
      label: 'Project settings (local) - Saved in .bike4mind/local.json (not committed)',
      value: 'local',
    });

    items.push({
      label: 'Project settings (team-wide) - Checked in at .bike4mind/config.json',
      value: 'project',
    });
  }

  items.push({
    label: 'User settings - Saved at ~/.bike4mind/config.json',
    value: 'global',
  });

  const handleSelect = (item: TrustLocationItem) => {
    onSelect(item.value);
  };

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1}>
        <Text bold>Where should this rule be saved?</Text>
      </Box>

      <SelectInput
        items={items}
        onSelect={handleSelect}
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
