import React, { useMemo } from 'react';
import { CommandSuggestions } from './CommandSuggestions';
import { CommandSuggestion } from './types';
import { CommandSuggestionsHeader } from './CommandSuggestionsHeader';
import { useAdminTools } from '@client/app/hooks/useAdminTools';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useGetSkills } from '@client/app/hooks/data/skills';

interface SlashCommandSuggestionsProps {
  input: string;
  onSelectSuggestion: (suggestion: string, selectionRange?: { start: number; end: number }) => void;
  onVisibilityChange?: (visible: boolean) => void;
}

const ALL_COMMANDS: CommandSuggestion[] = [
  {
    command: '/create_agent',
    description: 'Create a new AI agent',
    template: '/create_agent your-agent-name',
    example: 'MyAssistant',
    requiresAgentsFeature: true,
  },
  {
    command: '/gen_image',
    description: 'Generate an image',
    template: '/gen_image describe-your-image-here',
    example: 'A sunset over mountains',
  },
  {
    command: '/blog-publish',
    description: 'Publish content to your blog [ADMIN ONLY]',
    template: '/blog-publish optional-title-here',
    example: 'My Amazing Blog Post',
    requiresAdmin: true,
  },
  {
    command: '/blog-update',
    description: 'Update an existing blog post [ADMIN ONLY]',
    template: '/blog-update post-id-or-keywords',
    example: 'manta ray diving',
    requiresAdmin: true,
  },
];

export const SlashCommandSuggestions: React.FC<SlashCommandSuggestionsProps> = ({
  input,
  onSelectSuggestion,
  onVisibilityChange,
}) => {
  const { isFeatureEnabled } = useFeatureEnabled();
  const { canUseAdminTools } = useAdminTools();
  // Only fetch the user's skills when they're actually engaging the slash
  // picker. Without this gate, every chat-input render fires GET /api/skills
  // even for users who never type `/`. The 5-min staleTime softens reuse
  // within a session, but the first request per session still happens
  // eagerly. Gate matches the same `shouldShow` predicate the picker uses.
  const { data: skills = [] } = useGetSkills(input.startsWith('/'));

  const availableCommands = useMemo(() => {
    const isAgentsFeatureEnabled = isFeatureEnabled('enableAgents');

    const builtInCommands = ALL_COMMANDS.filter(command => {
      if (command.requiresAgentsFeature) return isAgentsFeatureEnabled;
      if (command.requiresAdmin) return canUseAdminTools;
      return true;
    });

    // Append user-defined skills as slash commands. The template is just
    // `/name ` (trailing space) so the user can type their args immediately;
    // the server-side SkillsFeature parses everything after the name as args.
    const skillCommands: CommandSuggestion[] = skills.map(skill => ({
      command: `/${skill.name}`,
      description: skill.description,
      template: skill.argumentHint ? `/${skill.name} ${skill.argumentHint}` : `/${skill.name} `,
      isSkill: true,
    }));

    return [...builtInCommands, ...skillCommands];
  }, [isFeatureEnabled, canUseAdminTools, skills]);

  const shouldShow = (inputValue: string, filtered: CommandSuggestion[]) => {
    return inputValue === '/' || (inputValue.startsWith('/') && !inputValue.includes(' ') && filtered.length > 0);
  };

  const filterFn = (suggestion: CommandSuggestion, inputValue: string) => {
    const inputLower = inputValue.toLowerCase();
    return suggestion.command.toLowerCase().includes(inputLower) || inputLower === '/';
  };

  return (
    <CommandSuggestions
      suggestions={availableCommands}
      input={input}
      onSelectSuggestion={onSelectSuggestion}
      onVisibilityChange={onVisibilityChange}
      shouldShow={shouldShow}
      filterFn={filterFn}
      title={<CommandSuggestionsHeader title="Quick Actions" />}
      maxWidth="400px"
      variant="default"
    />
  );
};
