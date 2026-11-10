import type { ToolDefinition } from '../../base/types';
import { describeFailure, resolvePage } from './resolvePage';

interface UpdateStateParams {
  patch?: unknown;
}

export const pageUpdateStateTool: ToolDefinition = {
  name: 'page_update_state',
  implementation: context => ({
    toolFn: async parameters => {
      const { patch } = (parameters ?? {}) as UpdateStateParams;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return 'Error: `patch` must be a JSON object.';
      }
      const resolved = await resolvePage(context);
      if ('error' in resolved) return resolved.error;

      const result = await resolved.port.patchState({
        pageId: resolved.page.id,
        userId: context.userId,
        patch: patch as Record<string, unknown>,
      });
      if (!result.ok) return describeFailure(result);
      return `State updated. Current state: ${JSON.stringify(result.page.state ?? {})}`;
    },
    toolSchema: {
      name: 'page_update_state',
      description:
        'Merge facts into the page state using a JSON merge patch (RFC 7386): objects merge key by key, ' +
        'a null value deletes that key, and arrays are replaced whole (send the full new array). ' +
        'Example: {"ingredients":["eggs","rice"],"diet":null}. Keys cannot start with "$" or contain ".".',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'object', description: 'The merge patch to apply to the page state.' },
        },
        required: ['patch'],
      },
    },
  }),
};
