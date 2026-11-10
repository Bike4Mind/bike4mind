import type { ToolDefinition } from '../../base/types';
import { describeFailure, resolvePage } from './resolvePage';

interface SetWidgetParams {
  action?: string;
  widget?: unknown;
  widgetId?: string;
}

// One flat shape instead of a oneOf per type: the registry-wide schema budget is tight, and the
// service validates the real discriminated union (PageWidgetSchema) on every call anyway.
const widgetShape = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['card-list', 'checklist', 'markdown'] },
    id: {
      type: 'string',
      description: 'Stable lowercase slug, e.g. "shopping-list".',
    },
    title: { type: 'string' },
    order: { type: 'integer', description: 'Lower sorts first.' },
    items: {
      type: 'array',
      description: 'card-list: {id, title, subtitle?, body?}. checklist: {id, label, checked?}.',
      items: { type: 'object' },
    },
    markdown: { type: 'string', description: 'markdown type only.' },
  },
  required: ['type', 'id'],
};

export const pageSetWidgetTool: ToolDefinition = {
  name: 'page_set_widget',
  implementation: context => ({
    toolFn: async parameters => {
      const params = (parameters ?? {}) as SetWidgetParams;
      if (params.action !== 'upsert' && params.action !== 'remove') {
        return 'Error: `action` must be "upsert" or "remove".';
      }
      if (params.action === 'remove' && (typeof params.widgetId !== 'string' || !params.widgetId)) {
        return 'Error: `widgetId` is required to remove a widget.';
      }
      if (params.action === 'upsert' && params.widget === undefined) {
        return 'Error: `widget` is required to upsert a widget.';
      }

      const resolved = await resolvePage(context);
      if ('error' in resolved) return resolved.error;
      const ref = { pageId: resolved.page.id, userId: context.userId };

      if (params.action === 'remove') {
        const removed = await resolved.port.removeWidget({ ...ref, widgetId: params.widgetId as string });
        return removed.ok ? `Widget "${params.widgetId}" removed.` : describeFailure(removed);
      }

      const result = await resolved.port.setWidget({ ...ref, widget: params.widget });
      if (!result.ok) return describeFailure(result);
      const widgetId = (params.widget as { id?: unknown } | null)?.id;
      return `Widget "${String(widgetId)}" saved. The page now has ${result.page.widgets?.length ?? 0} widget(s).`;
    },
    toolSchema: {
      name: 'page_set_widget',
      description:
        'Show or remove a display on the page. "upsert" adds or replaces the widget with that id (prefer reusing ' +
        'ids); "remove" deletes by widgetId. card-list and checklist need items; markdown needs markdown.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Operation.', enum: ['upsert', 'remove'] },
          widgetId: { type: 'string', description: 'For "remove".' },
          widget: { ...widgetShape, description: 'For "upsert".' },
        },
        required: ['action'],
      },
    },
  }),
};
