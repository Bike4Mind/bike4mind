import type { ToolDefinition } from '../../base/types';
import { resolvePage } from './resolvePage';

export const pageGetStateTool: ToolDefinition = {
  name: 'page_get_state',
  implementation: context => ({
    toolFn: async () => {
      const resolved = await resolvePage(context);
      if ('error' in resolved) return resolved.error;
      const { page } = resolved;
      return JSON.stringify({
        name: page.name,
        state: page.state ?? {},
        widgets: (page.widgets ?? []).map(widget => ({
          id: widget.id,
          type: widget.type,
          title: widget.title,
          itemCount: 'items' in widget ? widget.items.length : undefined,
        })),
      });
    },
    toolSchema: {
      name: 'page_get_state',
      description:
        'Read this page: its name, the stored state (the source of truth for what the user told you) and the ' +
        'ids, types and titles of the widgets currently shown. Call it before changing a page you have not seen this turn.',
      parameters: { type: 'object', properties: {} },
    },
  }),
};
