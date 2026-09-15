import React from 'react';
import { CommandSuggestions } from './CommandSuggestions';
import { CommandSuggestion } from './types';
import { useAdminTools } from '@client/app/hooks/useAdminTools';
import { CommandSuggestionsHeader } from './CommandSuggestionsHeader';

interface AdminCommandSuggestionsProps {
  input: string;
  onSelectSuggestion: (suggestion: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
}

const ADMIN_COMMANDS: CommandSuggestion[] = [
  {
    command: '/admin modal create',
    description: 'Create a new modal or banner. Sample: /admin modal create --type banner --title "Welcome to the app"',
  },
  {
    command: '/admin modal from-context',
    description: 'Create modal from chat history. Sample: /admin modal from-context --type banner --priority 10',
  },
  {
    command: '/admin modal list',
    description: 'List all modals',
  },
  {
    command: '/admin modal trigger',
    description: 'Show/trigger a modal by ID or title. Sample: /admin modal trigger 123',
  },
  {
    command: '/admin help',
    description: 'Show admin tools help',
  },
];

export const AdminCommandSuggestions: React.FC<AdminCommandSuggestionsProps> = ({
  input,
  onSelectSuggestion,
  onVisibilityChange,
}) => {
  const { canUseAdminTools } = useAdminTools();

  const shouldShow = (inputValue: string, filtered: CommandSuggestion[]) => {
    return canUseAdminTools && inputValue.startsWith('/admin') && filtered.length > 0;
  };

  const filterFn = (suggestion: CommandSuggestion, inputValue: string) => {
    return suggestion.command.toLowerCase().includes(inputValue.toLowerCase());
  };

  // Wrap onSelectSuggestion to ignore selectionRange (admin commands don't use templates)
  const handleSelectSuggestion = React.useCallback(
    (suggestion: string, _selectionRange?: { start: number; end: number }) => {
      onSelectSuggestion(suggestion);
    },
    [onSelectSuggestion]
  );

  if (!canUseAdminTools || !input.startsWith('/admin')) {
    return null;
  }

  return (
    <CommandSuggestions
      suggestions={ADMIN_COMMANDS}
      input={input}
      onSelectSuggestion={handleSelectSuggestion}
      onVisibilityChange={onVisibilityChange}
      shouldShow={shouldShow}
      filterFn={filterFn}
      variant="compact"
      title={<CommandSuggestionsHeader title="Admin Quick Actions" />}
    />
  );
};
