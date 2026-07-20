import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CliConfig } from '../storage';
import type { ModelInfo } from '@bike4mind/common';
import type { PluginDescriptor } from '../plugins/PluginStore';

/**
 * Configuration item types
 */
type ConfigItemType = 'select' | 'boolean' | 'number';

interface ConfigItem {
  key: string;
  label: string;
  type: ConfigItemType;
  options?: Array<{ label: string; value: unknown }>;
  min?: number;
  max?: number;
  step?: number;
  getValue: (config: CliConfig) => unknown;
  setValue: (config: CliConfig, value: unknown) => CliConfig;
}

const MAX_ITERATIONS_OPTIONS = [
  { label: '10', value: 10 },
  { label: '20', value: 20 },
  { label: '30', value: 30 },
  { label: '40', value: 40 },
  { label: '50', value: 50 },
  { label: 'Infinite', value: null },
];

const THEME_OPTIONS = [
  { label: 'dark', value: 'dark' },
  { label: 'light', value: 'light' },
];

const EXPORT_FORMAT_OPTIONS = [
  { label: 'markdown', value: 'markdown' },
  { label: 'json', value: 'json' },
];

/**
 * Build configuration items to display in the editor
 * @param availableModels - Models available for selection
 * @param pluginDescriptors - Installed plugins (valid ones get a feature toggle)
 */
function buildConfigItems(availableModels: ModelInfo[], pluginDescriptors: PluginDescriptor[] = []): ConfigItem[] {
  const modelOptions = availableModels.map(model => ({
    label: model.name,
    value: model.id,
  }));

  const items: ConfigItem[] = [];

  // Only add model selection if models are available
  if (modelOptions.length > 0) {
    items.push({
      key: 'model',
      label: 'Model',
      type: 'select' as const,
      options: modelOptions,
      getValue: config => {
        // Validate current model is in available models
        const modelExists = modelOptions.some(opt => opt.value === config.defaultModel);
        // If model doesn't exist, fallback to first available model or keep current
        return modelExists ? config.defaultModel : (modelOptions[0]?.value ?? config.defaultModel);
      },
      setValue: (config, value) => ({
        ...config,
        defaultModel: value as string,
      }),
    });
  }

  items.push(
    {
      key: 'maxIterations',
      label: 'Max Iterations',
      type: 'select' as const,
      options: MAX_ITERATIONS_OPTIONS,
      getValue: config => config.preferences.maxIterations,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          maxIterations: value as number | null,
        },
      }),
    },
    {
      key: 'maxTokens',
      label: 'Max Tokens',
      type: 'number' as const,
      min: 256,
      max: 128000,
      step: 256,
      getValue: config => config.preferences.maxTokens,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          maxTokens: value as number,
        },
      }),
    },
    {
      key: 'temperature',
      label: 'Temperature',
      type: 'number' as const,
      min: 0,
      max: 2,
      step: 0.1,
      getValue: config => config.preferences.temperature,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          temperature: value as number,
        },
      }),
    },
    {
      key: 'autoSave',
      label: 'Auto Save',
      type: 'boolean' as const,
      getValue: config => config.preferences.autoSave,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          autoSave: value as boolean,
        },
      }),
    },
    {
      key: 'autoCompact',
      label: 'Auto Compact',
      type: 'boolean' as const,
      getValue: config => config.preferences.autoCompact ?? true,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          autoCompact: value as boolean,
        },
      }),
    },
    {
      key: 'showThoughts',
      label: 'Show Thoughts',
      type: 'boolean' as const,
      getValue: config => config.preferences.showThoughts ?? true,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          showThoughts: value as boolean,
        },
      }),
    },
    {
      key: 'theme',
      label: 'Theme',
      type: 'select' as const,
      options: THEME_OPTIONS,
      getValue: config => config.preferences.theme,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          theme: value as 'light' | 'dark',
        },
      }),
    },
    {
      key: 'exportFormat',
      label: 'Export Format',
      type: 'select' as const,
      options: EXPORT_FORMAT_OPTIONS,
      getValue: config => config.preferences.exportFormat,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          exportFormat: value as 'markdown' | 'json',
        },
      }),
    },
    {
      key: 'enableDynamicAgentCreation',
      label: 'Dynamic Agents',
      type: 'boolean' as const,
      getValue: config => config.preferences.enableDynamicAgentCreation ?? false,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          enableDynamicAgentCreation: value as boolean,
        },
      }),
    },
    {
      key: 'enableCoordinatorMode',
      label: 'Coordinator Mode',
      type: 'boolean' as const,
      getValue: config => config.preferences.enableCoordinatorMode ?? false,
      setValue: (config, value) => ({
        ...config,
        preferences: {
          ...config.preferences,
          enableCoordinatorMode: value as boolean,
        },
      }),
    },
    {
      key: 'featuresTavern',
      label: 'Tavern',
      type: 'boolean' as const,
      getValue: config => config.features?.tavern ?? false,
      setValue: (config, value) => ({
        ...config,
        features: {
          ...config.features,
          tavern: value as boolean,
        },
      }),
    }
  );

  // Installed plugins get an auto-discovered toggle. Reserved keys are already
  // rejected at discovery, so these can never duplicate the built-in items.
  for (const descriptor of pluginDescriptors) {
    if (!descriptor.valid) {
      continue;
    }
    items.push({
      key: `featuresPlugin:${descriptor.configKey}`,
      label: `Plugin: ${descriptor.name}`,
      type: 'boolean' as const,
      getValue: config => config.features?.[descriptor.configKey] ?? false,
      setValue: (config, value) => ({
        ...config,
        features: {
          ...config.features,
          [descriptor.configKey]: value as boolean,
        },
      }),
    });
  }

  return items;
}

export interface ConfigEditorProps {
  config: CliConfig;
  availableModels: ModelInfo[];
  pluginDescriptors?: PluginDescriptor[];
  onSave: (config: CliConfig) => Promise<void>;
  onClose: () => void;
}

/**
 * Interactive configuration editor component
 *
 * Features:
 * - Arrow key navigation between settings
 * - Spacebar/left/right to cycle options
 * - +/- keys to adjust numeric values
 * - q or Escape to save and exit
 */
export function ConfigEditor({ config, availableModels, pluginDescriptors = [], onSave, onClose }: ConfigEditorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editedConfig, setEditedConfig] = useState<CliConfig>(config);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const configItems = useMemo(
    () => buildConfigItems(availableModels, pluginDescriptors),
    [availableModels, pluginDescriptors]
  );

  // Check if config has been modified
  const hasChanges = useMemo(() => {
    return (
      JSON.stringify(config.preferences) !== JSON.stringify(editedConfig.preferences) ||
      config.defaultModel !== editedConfig.defaultModel ||
      JSON.stringify(config.features) !== JSON.stringify(editedConfig.features)
    );
  }, [
    config.preferences,
    editedConfig.preferences,
    config.defaultModel,
    editedConfig.defaultModel,
    config.features,
    editedConfig.features,
  ]);

  const handleSaveAndClose = async () => {
    if (hasChanges) {
      try {
        setSaveError(null);
        setIsSaving(true);
        await onSave(editedConfig);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Failed to save');
        setIsSaving(false);
        return; // Don't close on error
      }
      setIsSaving(false);
    }
    onClose();
  };

  // Handle keyboard input
  useInput((input, key) => {
    const currentItem = configItems[selectedIndex];

    // Navigation
    if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : configItems.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(prev => (prev < configItems.length - 1 ? prev + 1 : 0));
      return;
    }

    // Save and exit (don't process if already saving)
    if ((key.escape || input === 'q') && !isSaving) {
      handleSaveAndClose();
      return;
    }

    // Value modification based on item type
    if (currentItem.type === 'select' && currentItem.options) {
      const currentValue = currentItem.getValue(editedConfig);
      const currentIdx = currentItem.options.findIndex(opt => opt.value === currentValue);

      if (key.leftArrow || input === ' ') {
        // Cycle backwards (or wrap if using space, just cycle forward)
        let newIdx: number;
        if (input === ' ') {
          // Space cycles forward
          newIdx = (currentIdx + 1) % currentItem.options.length;
        } else {
          // Left arrow cycles backwards
          newIdx = currentIdx > 0 ? currentIdx - 1 : currentItem.options.length - 1;
        }
        const newValue = currentItem.options[newIdx].value;
        setEditedConfig(currentItem.setValue(editedConfig, newValue));
      } else if (key.rightArrow) {
        // Cycle forwards
        const newIdx = (currentIdx + 1) % currentItem.options.length;
        const newValue = currentItem.options[newIdx].value;
        setEditedConfig(currentItem.setValue(editedConfig, newValue));
      }
    } else if (currentItem.type === 'boolean') {
      if (input === ' ' || key.leftArrow || key.rightArrow) {
        const currentValue = currentItem.getValue(editedConfig) as boolean;
        setEditedConfig(currentItem.setValue(editedConfig, !currentValue));
      }
    } else if (currentItem.type === 'number') {
      const currentValue = currentItem.getValue(editedConfig) as number;
      const step = currentItem.step || 1;
      const min = currentItem.min ?? 0;
      const max = currentItem.max ?? Infinity;

      if (key.leftArrow || input === '-') {
        const newValue = Math.max(min, currentValue - step);
        // Round to avoid floating point issues
        const rounded = Math.round(newValue * 10) / 10;
        setEditedConfig(currentItem.setValue(editedConfig, rounded));
      } else if (key.rightArrow || input === '+' || input === '=') {
        const newValue = Math.min(max, currentValue + step);
        // Round to avoid floating point issues
        const rounded = Math.round(newValue * 10) / 10;
        setEditedConfig(currentItem.setValue(editedConfig, rounded));
      }
    }
  });

  /**
   * Format a value for display
   */
  const formatValue = (item: ConfigItem, value: unknown): string => {
    if (item.type === 'boolean') {
      return value ? 'On' : 'Off';
    }
    if (item.type === 'select' && item.options) {
      const option = item.options.find(opt => opt.value === value);
      return option?.label || String(value);
    }
    if (item.type === 'number') {
      return String(value);
    }
    return String(value);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginY={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          Settings
        </Text>
        {isSaving ? (
          <Text color="yellow">Saving...</Text>
        ) : hasChanges ? (
          <Text dimColor color="yellow">
            (unsaved changes)
          </Text>
        ) : null}
      </Box>

      {/* Error display */}
      {saveError && (
        <Box marginBottom={1}>
          <Text color="red">Error: {saveError}</Text>
        </Box>
      )}

      {/* Config items */}
      <Box flexDirection="column" marginBottom={1}>
        {configItems.map((item, index) => {
          const isSelected = index === selectedIndex;
          const value = item.getValue(editedConfig);
          const displayValue = formatValue(item, value);

          // Determine if item has selectable options (for < > display)
          const hasOptions = item.type === 'select' || item.type === 'boolean' || item.type === 'number';

          return (
            <Box key={item.key}>
              {/* Selection indicator */}
              <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '> ' : '  '}</Text>

              {/* Label */}
              <Box width={18}>
                <Text bold={isSelected} color={isSelected ? 'white' : 'gray'}>
                  {item.label}:
                </Text>
              </Box>

              {/* Value with arrows for navigation hint */}
              <Box>
                {hasOptions && isSelected && <Text dimColor>{'< '}</Text>}
                <Text bold={isSelected} color={isSelected ? 'green' : undefined}>
                  {displayValue}
                </Text>
                {hasOptions && isSelected && <Text dimColor>{' >'}</Text>}
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Help text */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>{'\u2191/\u2193: Navigate | Space/\u2190/\u2192: Change | q/Esc: Save & Exit'}</Text>
      </Box>
    </Box>
  );
}
