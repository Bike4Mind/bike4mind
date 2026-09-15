import { useState, useEffect, useCallback } from 'react';
import { CommandSuggestion } from '@client/app/components/common/CommandSuggestions/types';

interface UseCommandSuggestionsOptions {
  suggestions: CommandSuggestion[];
  input: string;
  onSelectSuggestion: (suggestion: string, selectionRange?: { start: number; end: number }) => void;
  shouldShow?: (input: string, filtered: CommandSuggestion[]) => boolean;
  filterFn?: (suggestion: CommandSuggestion, input: string) => boolean;
  enabled?: boolean;
}

export const useCommandSuggestions = ({
  suggestions,
  input,
  onSelectSuggestion,
  shouldShow,
  filterFn,
  enabled = true,
}: UseCommandSuggestionsOptions) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const defaultFilterFn = useCallback((suggestion: CommandSuggestion, inputValue: string) => {
    const inputLower = inputValue.toLowerCase();
    return suggestion.command.toLowerCase().includes(inputLower);
  }, []);

  const filtered = suggestions.filter(s => {
    if (!enabled) return false;
    const filter = filterFn || defaultFilterFn;
    return filter(s, input);
  });

  const selectSuggestion = useCallback(
    (suggestion: CommandSuggestion) => {
      const textToInsert = suggestion.template || suggestion.command + ' ';

      // If there's a template, calculate selection range for the placeholder
      if (suggestion.template) {
        const commandPart = suggestion.command + ' ';
        const afterCommand = suggestion.template.substring(commandPart.length);
        const match = afterCommand.match(/[a-z0-9_-]+/i);

        if (match && match.index !== undefined) {
          const start = commandPart.length + match.index;
          const end = start + match[0].length;
          onSelectSuggestion(textToInsert, { start, end });
          return;
        }
      }

      // No template or no placeholder found, just insert command
      onSelectSuggestion(textToInsert);
    },
    [onSelectSuggestion]
  );

  const isVisible = shouldShow ? shouldShow(input, filtered) : filtered.length > 0;

  useEffect(() => {
    if (!isVisible || !enabled || filtered.length === 0) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (filtered[selectedIndex]) {
          selectSuggestion(filtered[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onSelectSuggestion('');
      }
      else if (e.key >= '1' && e.key <= '9') {
        const index = parseInt(e.key) - 1;
        if (index < filtered.length) {
          e.preventDefault();
          selectSuggestion(filtered[index]);
        }
      }
    };

    // Capture phase catches the event before React's synthetic events
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, selectedIndex, selectSuggestion, input, onSelectSuggestion, isVisible, enabled]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  return {
    filtered,
    selectedIndex,
    setSelectedIndex,
    selectSuggestion,
    isVisible,
  };
};
