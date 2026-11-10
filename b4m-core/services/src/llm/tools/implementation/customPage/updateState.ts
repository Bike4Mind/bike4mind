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
        'Merge facts into the page state (JSON merge patch): objects merge by key, null deletes a key, ' +
        'arrays are replaced whole. Example: {"ingredients":["eggs","rice"],"diet":null}.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'object', description: 'Merge patch.' },
        },
        required: ['patch'],
      },
    },
  }),
};
