import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { ModelInfo } from '@bike4mind/common';
import { CustomTextInput } from './CustomTextInput';

interface ModelPickerProps {
  models: ModelInfo[];
  currentModelId: string;
  onSelect: (model: ModelInfo) => void;
  onCancel: () => void;
}

type ModelItem = {
  key: string;
  label: string;
  value: ModelInfo;
};

/**
 * Interactive model picker for the /model command. A live filter box narrows
 * the list by a case-insensitive substring match against each model's id and
 * name; Enter selects the highlighted model.
 */
export function ModelPicker({ models, currentModelId, onSelect, onCancel }: ModelPickerProps) {
  const [filter, setFilter] = useState('');

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const items: ModelItem[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return models
      .filter(m => q === '' || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      .map(m => ({
        key: m.id,
        label: `${m.id === currentModelId ? '● ' : '  '}${m.name}  (${m.id})`,
        value: m,
      }));
  }, [models, filter, currentModelId]);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box marginBottom={1}>
        <Text bold>Select a model:</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Filter: </Text>
        <CustomTextInput value={filter} onChange={setFilter} onSubmit={() => {}} placeholder="type to filter..." />
      </Box>

      {items.length === 0 ? (
        <Text color="yellow">No models match &quot;{filter}&quot;</Text>
      ) : (
        <SelectInput
          items={items}
          limit={10}
          onSelect={item => onSelect(item.value)}
          itemComponent={({ isSelected, label }) => (
            <Box>
              <Text color={isSelected ? 'cyan' : undefined}>{label}</Text>
            </Box>
          )}
        />
      )}

      <Box marginTop={1}>
        <Text dimColor>Type to filter, ↑↓ to navigate, Enter to select, Esc to cancel</Text>
      </Box>
    </Box>
  );
}
