import { ReactNode } from 'react';

export interface CommandSuggestion {
  command: string;
  description: string;
  template?: string; // Optional template with placeholder
  example?: string; // Optional example to show in description
  // Feature gating flags (optional)
  requiresAgentsFeature?: boolean;
  requiresAdmin?: boolean;
  /**
   * Marks the entry as a user-defined skill (sourced from `/api/skills`).
   * Allows the picker UI to render a "Skill" badge and lets analytics
   * distinguish skill invocations from built-in slash commands.
   */
  isSkill?: boolean;
}

export interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  input: string;
  onSelectSuggestion: (suggestion: string, selectionRange?: { start: number; end: number }) => void;
  onVisibilityChange?: (visible: boolean) => void;
  title?: string | ReactNode;
  shouldShow?: (input: string, filtered: CommandSuggestion[]) => boolean;
  filterFn?: (suggestion: CommandSuggestion, input: string) => boolean;
  maxWidth?: string | number;
  variant?: 'default' | 'compact';
}
