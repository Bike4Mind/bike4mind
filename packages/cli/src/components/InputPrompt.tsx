import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { CustomTextInput } from './CustomTextInput.js';
import { CommandAutocomplete } from './CommandAutocomplete.js';
import { FileAutocomplete } from './FileAutocomplete.js';
import { searchCommands } from '../utils/fuzzySearch.js';
import { searchFiles, type FileSearchResult } from '../utils/fileSearch.js';
import { ImageInputDetector } from '../utils/imageDetector.js';
import type { CommandDefinition } from '../config/commands.js';
import { useCliStore } from '../store/index.js';
import { IMAGE_DETECTION_MAX_LENGTH } from '../config/constants.js';
import { useDebounce } from '../hooks/useDebounce.js';

/**
 * Check if input looks like a file path (to avoid showing command autocomplete)
 */
function looksLikeFilePath(input: string): boolean {
  const trimmed = input.trim();

  // Check for absolute paths with multiple segments (e.g., /Users/..., /tmp/...)
  if (trimmed.startsWith('/')) {
    const hasMultipleSegments = trimmed.indexOf('/', 1) !== -1;
    if (hasMultipleSegments) return true;
  }

  // Check for home directory paths
  if (trimmed.startsWith('~')) return true;

  // Check for Windows paths
  if (trimmed.match(/^[a-zA-Z]:\\/)) return true;

  return false;
}

interface InputPromptProps {
  onSubmit: (input: string) => void;
  onBashCommand?: (command: string) => void; // Execute bash command directly
  onImageDetected?: (imageData: Buffer) => Promise<string>; // Returns placeholder
  disabled?: boolean;
  history?: string[];
  commands?: CommandDefinition[]; // Merged built-in + custom commands
  prefillInput?: string; // Pre-fill input (e.g., from rewind)
  onPrefillConsumed?: () => void; // Called after prefill is applied
  onBashModeChange?: (isBashMode: boolean) => void; // Notify parent of bash mode state
}

interface FileAutocompleteState {
  active: boolean;
  startIndex: number; // Position of @ in input
  query: string; // Characters after @
}

/**
 * Find the position of the @ trigger in the input
 * Only triggers after space or at start of input (not mid-word like emails)
 * Fuzzy search filters results, and processFileReferences handles strict validation
 */
function findAtTrigger(value: string): { startIndex: number; query: string } | null {
  // Search backwards from the end to find the most recent @ trigger
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] === '@') {
      // Check if @ is at start or preceded by space (prevents mid-word triggers like emails)
      const isValid = i === 0 || value[i - 1] === ' ';
      if (isValid) {
        const query = value.slice(i + 1);
        // If the query contains a space, the @ reference is "complete"
        if (query.includes(' ')) {
          return null;
        }
        return { startIndex: i, query };
      }
    }
  }
  return null;
}

export function InputPrompt({
  onSubmit,
  onBashCommand,
  onImageDetected,
  disabled = false,
  history = [],
  commands = [],
  prefillInput,
  onPrefillConsumed,
  onBashModeChange,
}: InputPromptProps) {
  // Use store for input value (allows Ctrl+C to clear from outside)
  const value = useCliStore(state => state.inputValue);
  const setValue = useCliStore(state => state.setInputValue);
  const pastedContent = useCliStore(state => state.pastedContent);
  const pastedLineCount = useCliStore(state => state.pastedLineCount);
  const setPastedContent = useCliStore(state => state.setPastedContent);
  const clearPaste = useCliStore(state => state.clearPaste);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 means not in history
  const [tempInput, setTempInput] = useState(''); // Store current input when navigating history
  const inputKey = useRef(0); // Key to force remount CustomTextInput

  // Handle prefill input (e.g., from rewind command)
  useEffect(() => {
    if (prefillInput) {
      setValue(prefillInput);
      onPrefillConsumed?.();
    }
  }, [prefillInput, onPrefillConsumed]);

  // File autocomplete state
  const [fileAutocomplete, setFileAutocomplete] = useState<FileAutocompleteState | null>(null);
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);

  // Check if bash mode is active (input starts with !)
  const isBashMode = value.startsWith('!');

  // Notify parent when bash mode changes
  useEffect(() => {
    onBashModeChange?.(isBashMode);
  }, [isBashMode, onBashModeChange]);

  // Check if command autocomplete should be shown (input starts with / but is not a file path)
  // Also hide if there's a space after / (e.g., "/ a" means user is typing freely, not a command)
  const commandQuery = value.startsWith('/') ? value.slice(1) : '';
  const shouldShowCommandAutocomplete =
    value.startsWith('/') &&
    !disabled &&
    !fileAutocomplete?.active &&
    !looksLikeFilePath(value) &&
    !pastedContent &&
    !commandQuery.includes(' ');

  // Get filtered commands using fuzzy search
  const filteredCommands = useMemo(() => {
    if (!shouldShowCommandAutocomplete) return [];
    return searchCommands(commandQuery, commands);
  }, [shouldShowCommandAutocomplete, commandQuery, commands]);

  // Debounce the file query to reduce expensive searchFiles calls
  // Use 200ms - search only triggers after you stop typing for 200ms
  const debouncedFileQuery = useDebounce(fileAutocomplete?.query ?? '', 200);

  // Get filtered files using async fuzzy search
  const [filteredFiles, setFilteredFiles] = useState<FileSearchResult[]>([]);

  useEffect(() => {
    if (!fileAutocomplete?.active) {
      setFilteredFiles([]);
      return;
    }

    let cancelled = false;

    searchFiles(debouncedFileQuery)
      .then(results => {
        if (!cancelled) {
          setFilteredFiles(results);
        }
      })
      .catch(error => {
        if (!cancelled) {
          console.error('File search error:', error);
          setFilteredFiles([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileAutocomplete?.active, debouncedFileQuery]);

  // Reset selection index when filtered commands change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands]);

  // Reset file selection index when filtered files change
  useEffect(() => {
    setFileSelectedIndex(0);
  }, [filteredFiles]);

  // Handle navigation keys (autocomplete and history).
  // Text editing shortcuts (Ctrl+U, Ctrl+K, etc.) are handled by CustomTextInput.
  useInput(
    (input, key) => {
      // File autocomplete navigation
      if (fileAutocomplete?.active && filteredFiles.length > 0) {
        if (key.upArrow) {
          setFileSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredFiles.length - 1));
          return;
        } else if (key.downArrow) {
          setFileSelectedIndex(prev => (prev < filteredFiles.length - 1 ? prev + 1 : 0));
          return;
        } else if (key.tab) {
          // Tab to select file
          const selectedFile = filteredFiles[fileSelectedIndex];
          if (selectedFile) {
            insertSelectedFile(selectedFile);
          }
          return;
        } else if (key.escape) {
          // Escape to cancel file autocomplete
          setFileAutocomplete(null);
          return;
        }
      }

      // Command autocomplete navigation (when typing slash commands)
      if (shouldShowCommandAutocomplete && filteredCommands.length > 0) {
        if (key.upArrow) {
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
          return;
        } else if (key.downArrow) {
          setSelectedIndex(prev => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
          return;
        }
      }

      // History navigation (when NOT in any autocomplete mode)
      if (!shouldShowCommandAutocomplete && !fileAutocomplete?.active && history.length > 0) {
        if (key.upArrow) {
          // Navigate to older command
          if (historyIndex === -1) {
            // First time pressing up - save current input
            setTempInput(value);
            setHistoryIndex(0);
            setValue(history[0]);
          } else if (historyIndex < history.length - 1) {
            // Navigate to older command
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            setValue(history[newIndex]);
          }
        } else if (key.downArrow) {
          // Navigate to newer command
          if (historyIndex > 0) {
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);
            setValue(history[newIndex]);
          } else if (historyIndex === 0) {
            // Back to current input
            setHistoryIndex(-1);
            setValue(tempInput);
          }
        }
      }
    },
    { isActive: !disabled }
  );

  /**
   * Insert the selected file path at the @ position
   */
  const insertSelectedFile = (file: FileSearchResult) => {
    if (!fileAutocomplete) return;

    const beforeAt = value.slice(0, fileAutocomplete.startIndex);
    const afterQuery = value.slice(fileAutocomplete.startIndex + 1 + fileAutocomplete.query.length);

    // For directories, append / to allow continued navigation
    const pathToInsert = file.isDirectory ? `@${file.path}/` : `@${file.path}`;

    const newValue = beforeAt + pathToInsert + afterQuery;
    setValue(newValue);

    // If it's a directory, keep autocomplete active for further navigation
    if (file.isDirectory) {
      setFileAutocomplete({
        active: true,
        startIndex: fileAutocomplete.startIndex,
        query: file.path + '/',
      });
      setFileSelectedIndex(0);
    } else {
      // File selected, close autocomplete
      setFileAutocomplete(null);
    }
  };

  const handleSubmit = (input: string) => {
    if (disabled) return;

    // Paste active: submit full pasted content
    if (pastedContent) {
      const fullContent = pastedContent;
      clearPaste();
      onSubmit(fullContent);
      return;
    }

    if (!input.trim()) return;

    // If file autocomplete is visible with results, select the file with Enter
    if (fileAutocomplete?.active && filteredFiles.length > 0) {
      const selectedFile = filteredFiles[fileSelectedIndex];
      if (selectedFile) {
        insertSelectedFile(selectedFile);
      }
      return;
    }

    // If command autocomplete is visible, autocomplete to the selected command
    if (shouldShowCommandAutocomplete && filteredCommands.length > 0) {
      const selectedCommand = filteredCommands[selectedIndex];
      const commandText = `/${selectedCommand.name}`;

      // If command requires args, only autocomplete (don't auto-submit)
      if (selectedCommand.args) {
        setValue(commandText + ' ');
        setHistoryIndex(-1); // Reset history navigation
        return;
      }

      // Otherwise, autocomplete AND auto-submit (for commands without args)
      setValue(''); // Clear input
      setHistoryIndex(-1); // Reset history navigation
      onSubmit(commandText); // Submit the autocompleted command immediately
      return;
    }

    // Handle bash mode - execute command directly without agent
    if (isBashMode && onBashCommand) {
      const command = input.slice(1).trim(); // Remove the leading !
      if (command) {
        onBashCommand(command);
        setValue('');
        setHistoryIndex(-1);
        setFileAutocomplete(null);
      }
      return;
    }

    // Otherwise submit normally
    onSubmit(input);
    setValue('');
    setHistoryIndex(-1); // Reset history navigation
    setFileAutocomplete(null); // Reset file autocomplete
  };

  // Pasted text arrives already normalized/truncated from CustomTextInput.
  // Prepend any existing typed text so it isn't lost when pasting.
  const handlePaste = (content: string) => {
    const lineCount = content.split('\n').length;
    const prefix = value.trim();
    const combined = prefix ? `${prefix}\n${content}` : content;
    setPastedContent(combined, lineCount);
  };

  // Handle input changes - detect @ trigger and images
  const handleChange = async (newValue: string) => {
    if (pastedContent) {
      clearPaste();
    }

    // Only run image detection for short inputs to avoid blocking on large pastes
    if (newValue.length <= IMAGE_DETECTION_MAX_LENGTH) {
      if (ImageInputDetector.containsImageData(newValue)) {
        const imageEvent = ImageInputDetector.extractImageData(newValue);
        if (imageEvent && onImageDetected) {
          // Get placeholder from parent (imageRenderer)
          const placeholder = await onImageDetected(imageEvent.data);

          // Remove image data from input and replace with placeholder + space
          setValue(`${placeholder} `);
          return;
        }
      }
    }

    setValue(newValue);
    // If user types after navigating history, reset navigation
    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      setTempInput('');
    }
    // Check for @ trigger
    const atTrigger = findAtTrigger(newValue);
    if (atTrigger) {
      setFileAutocomplete({
        active: true,
        startIndex: atTrigger.startIndex,
        query: atTrigger.query,
      });
    } else {
      setFileAutocomplete(null);
    }
  };

  // Determine placeholder text based on mode
  const getPlaceholder = () => {
    if (disabled) return '';
    if (isBashMode) return 'Enter shell command to execute...';
    return 'Type your message, /help for commands, @file to reference, or ! for bash';
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={disabled ? 'gray' : isBashMode ? 'yellow' : 'cyan'} dimColor={disabled}>
          {isBashMode ? '$ ' : '> '}
        </Text>
        <CustomTextInput
          key={inputKey.current}
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          onPaste={handlePaste}
          pasteIndicator={pastedContent ? `[pasted +${pastedLineCount} lines]` : null}
          placeholder={getPlaceholder()}
          showCursor={!disabled}
          disabled={disabled}
        />
      </Box>
      {shouldShowCommandAutocomplete && (
        <CommandAutocomplete commands={filteredCommands} selectedIndex={selectedIndex} />
      )}
      {fileAutocomplete?.active && (
        <FileAutocomplete files={filteredFiles} selectedIndex={fileSelectedIndex} query={fileAutocomplete.query} />
      )}
    </Box>
  );
}
