import { ToolDefinition } from '../../base/types';
import { getViewById, resolveNavigationIntents } from '@bike4mind/common';

interface NavigateViewParams {
  suggestions: Array<{
    viewId: string;
    reason: string;
  }>;
}

export const navigateViewTool: ToolDefinition = {
  name: 'navigate_view',
  implementation: context => ({
    // The buttons reach the user via onNavigationIntents before this result returns, so a
    // follow-up model round would only restate the answer (see shouldEndTurnAfterTools).
    endsTurnAfterText: true,
    toolFn: async value => {
      const params = value as NavigateViewParams;
      const { suggestions } = params;

      context.logger.log('🧭 navigate_view: Received suggestions:', JSON.stringify(suggestions));

      if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
        return 'No navigation suggestions provided.';
      }

      // Cap at 3 suggestions
      const capped = suggestions.slice(0, 3);

      // Validate all viewIds exist in the registry
      const invalid = capped.filter(s => !getViewById(s.viewId));
      if (invalid.length > 0) {
        context.logger.log(
          '🧭 navigate_view: Unknown viewIds:',
          invalid.map(s => s.viewId)
        );
      }

      // Resolve against registry with admin check
      const isAdmin = context.user?.isAdmin === true;
      const intents = resolveNavigationIntents(capped, isAdmin);

      if (intents.length === 0) {
        return 'No valid navigation views matched the provided viewIds.';
      }

      context.logger.log(
        '🧭 navigate_view: Resolved intents:',
        intents.map(i => i.viewId)
      );

      // Return JSON with sentinel for ChatCompletionProcess extraction
      return JSON.stringify({
        __navigationIntents: true,
        intents,
        message:
          `Navigation buttons shown to the user: ${intents.map(i => i.label).join(', ')}. ` +
          'Your answer text is already visible above them, so do not write any more text or repeat it. ' +
          'Only if you have not answered yet, answer now.',
      });
    },
    toolSchema: {
      name: 'navigate_view',
      description:
        'Suggest navigation to relevant app views as inline action buttons the user can click. ALWAYS use this tool when your response discusses a topic that has a matching view (e.g., scheduling -> opti.scheduling, user management -> admin.users). Call it in the same response as your answer, never followed by more prose.',
      parameters: {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            description: 'Navigation suggestions (1-3 items). Each suggests a view the user might want to visit.',
            items: {
              type: 'object',
              properties: {
                viewId: {
                  type: 'string',
                  description: 'The view ID from the available views list (e.g., "opti.scheduling", "admin.users")',
                },
                reason: {
                  type: 'string',
                  description: 'Brief reason why this view is relevant (max 80 chars, shown as tooltip)',
                },
              },
              required: ['viewId', 'reason'],
            },
            maxItems: 3,
            minItems: 1,
          },
        },
        required: ['suggestions'],
      },
    },
  }),
};
